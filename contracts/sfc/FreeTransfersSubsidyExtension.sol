// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISubsidiesExtension} from "../interfaces/ISubsidiesExtension.sol";
import {SUBSIDY_MODE_NONE, SUBSIDY_MODE_TRACKED} from "../interfaces/ISubsidiesRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Version} from "../version/Version.sol";

/**
 * @title Subsidy Projects Registry
 * @notice Registry allowing project owners to sponsor ERC-20 transfer on their tokens.
 *         The amount of sponsored transactions is rate-limited per project.
 * @custom:security-contact security@fantom.foundation
 */
contract FreeTransfersSubsidyExtension is ISubsidiesExtension, OwnableUpgradeable, UUPSUpgradeable, Version {
    struct LeakyBucket {
        // uint40 + uint96 + uint96 = 29 bytes, fits in 1 slot
        uint40 lastTimestamp; // the last update of count
        uint96 count; // current level of the bucket (at lastTimestamp)
        uint96 dailyLimit; // maximum bucket level, refilled at a rate of limit per day
    }

    struct Project {
        address owner; // slot 0: 20 bytes
        LeakyBucket bucket; // slot 1: 29 bytes
    }

    // only the SubsidiesRegistry contract is allowed to call track()
    address private constant SUBSIDIES_REGISTRY = 0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2;

    /// top-byte prefix embedded in tracking IDs to identify this contract's tracked transactions
    bytes32 private constant TRACKING_ID_PREFIX = bytes32(uint256(0xF7) << 248);

    /// @notice Maps project IDs to their details. Project ID 0 is reserved and treated as non-existent.
    mapping(uint32 projectId => Project) private projects;

    /// @notice Maps an ERC-20 token address to the project that sponsors its transfers.
    mapping(address token => uint32 projectId) public tokenToProject;

    event ProjectRegistered(uint32 indexed projectId, address indexed owner, uint96 freeTransfersDailyLimit);
    event ProjectOwnerChanged(uint32 indexed projectId, address indexed newOwner);
    event FreeTransfersDailyLimitChanged(uint32 indexed projectId, uint96 newDailyLimit);
    event TokenAdded(uint32 indexed projectId, address indexed token, address indexed by);
    event TokenRemoved(uint32 indexed projectId, address indexed token, address indexed by);

    error InvalidProjectId();
    error InvalidOwnerAddress();
    error ProjectAlreadyExists();
    error ProjectNotFound();
    error NotProjectOwner();
    error TokenAlreadyAssigned();
    error TokenNotInProject();
    error NotSupported();
    error NotNode();
    error InvalidTrackingId();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract. The owner is copied from the SubsidiesRegistry contract.
    function initialize() external initializer {
        __Ownable_init(OwnableUpgradeable(SUBSIDIES_REGISTRY).owner());
        __UUPSUpgradeable_init();
    }

    /// @notice Register a new project with an initial daily free transfer limit.
    /// @param projectId Unique 32-bit identifier for the project. Must be non-zero.
    /// @param projectOwner Address that will manage the project's token list.
    /// @param dailyLimit Maximum free ERC-20 transfers per day for this project.
    function registerProject(uint32 projectId, address projectOwner, uint96 dailyLimit) external onlyOwner {
        require(projectId != 0, InvalidProjectId());
        require(projectOwner != address(0), InvalidOwnerAddress());
        require(projects[projectId].owner == address(0), ProjectAlreadyExists());
        projects[projectId].owner = projectOwner;
        projects[projectId].bucket.dailyLimit = dailyLimit;
        projects[projectId].bucket.count = dailyLimit;
        projects[projectId].bucket.lastTimestamp = uint40(block.timestamp);
        emit ProjectRegistered(projectId, projectOwner, dailyLimit);
    }

    /// @notice Transfer ownership of a project to a new address.
    function setProjectOwner(uint32 projectId, address newOwner) external onlyOwner {
        require(newOwner != address(0), InvalidOwnerAddress());
        require(projects[projectId].owner != address(0), ProjectNotFound());
        projects[projectId].owner = newOwner;
        emit ProjectOwnerChanged(projectId, newOwner);
    }

    /// @notice Update the daily free transfer limit for a project. Set to 0 to effectively pause it.
    function setFreeTransfersDailyLimit(uint32 projectId, uint96 dailyLimit) external onlyOwner {
        require(projects[projectId].owner != address(0), ProjectNotFound());
        projects[projectId].bucket.dailyLimit = dailyLimit;
        projects[projectId].bucket.count = dailyLimit;
        projects[projectId].bucket.lastTimestamp = uint40(block.timestamp);
        emit FreeTransfersDailyLimitChanged(projectId, dailyLimit);
    }

    /// @notice Add an ERC-20 token to the project's sponsored token list.
    function addToken(uint32 projectId, address token) external {
        require(projects[projectId].owner != address(0), ProjectNotFound());
        require(projects[projectId].owner == msg.sender || msg.sender == owner(), NotProjectOwner());
        uint32 existing = tokenToProject[token];
        require(existing == 0 || existing == projectId, TokenAlreadyAssigned());
        tokenToProject[token] = projectId;
        emit TokenAdded(projectId, token, msg.sender);
    }

    /// @notice Remove an ERC-20 token from the project's sponsored token list.
    function removeToken(uint32 projectId, address token) external {
        require(projects[projectId].owner == msg.sender || msg.sender == owner(), NotProjectOwner());
        require(tokenToProject[token] == projectId, TokenNotInProject());
        delete tokenToProject[token];
        emit TokenRemoved(projectId, token, msg.sender);
    }

    /// @notice Returns the number of free ERC-20 transfers currently available to a project.
    function freeTransfersRemaining(uint32 projectId) external view returns (uint256) {
        Project storage p = projects[projectId];
        require(p.owner != address(0), ProjectNotFound());
        return _freeTransfersRemaining(p.bucket);
    }

    function _freeTransfersRemaining(LeakyBucket storage bucket) private view returns (uint96) {
        uint96 limit = bucket.dailyLimit;
        uint256 refilled = ((block.timestamp - bucket.lastTimestamp) * uint256(limit)) / 1 days;
        if (refilled >= uint256(limit)) return limit;
        // refilled < limit -> fits into uint96
        uint104 level = uint104(bucket.count) + uint104(refilled);
        uint104 cap = uint104(limit);
        // cap fits into uint96 -> minimum of level and cap fits into uint96
        return uint96(level > cap ? cap : level);
    }

    /// @notice Check if a transaction is covered by a project subsidy and return the tracking ID.
    /// @dev The Sonic node guarantees that chooseFund, the sponsored transaction itself, and the
    ///      subsequent track() call are never interleaved with other sponsored transactions of the
    ///      same project. Bucket consistency therefore does not require on-chain mutual exclusion.
    /// @param to Transaction recipient (the ERC-20 token contract)
    /// @param callData Transaction call data
    /// @return mode SUBSIDY_MODE_TRACKED if sponsored, SUBSIDY_MODE_NONE otherwise.
    /// @return payload Tracking ID encoding the 0xF7 prefix and project ID, zero otherwise.
    function chooseFund(
        address /*from*/,
        address to,
        uint256 /*value*/,
        uint256 /*nonce*/,
        bytes calldata callData,
        uint256 /*fee*/
    ) external view returns (uint256 mode, bytes32 payload) {
        if (callData.length == 68 && bytes4(callData[:4]) == IERC20.transfer.selector) {
            uint32 projectId = tokenToProject[to];
            if (projectId == 0) return (SUBSIDY_MODE_NONE, bytes32(0));
            Project storage p = projects[projectId];
            if (_freeTransfersRemaining(p.bucket) < 1) {
                return (SUBSIDY_MODE_NONE, bytes32(0)); // rate limit reached
            }
            return (SUBSIDY_MODE_TRACKED, TRACKING_ID_PREFIX | bytes32(uint256(projectId)));
        }

        return (SUBSIDY_MODE_NONE, bytes32(0));
    }

    /// @notice Consume one free transfer from the project's bucket after a sponsored transaction.
    /// @dev Intended to be called only by SubsidiesRegistry, which forwards the call from the Sonic node.
    /// @param trackingId Tracking ID returned by chooseFund, encoding the 0xF7 prefix and project ID.
    function track(bytes32 trackingId, uint256 /*fee*/) external {
        require(msg.sender == SUBSIDIES_REGISTRY, NotNode());
        require(trackingId & bytes32(uint256(0xFF) << 248) == TRACKING_ID_PREFIX, InvalidTrackingId());
        uint32 projectId = uint32(uint256(trackingId));
        Project storage p = projects[projectId];
        uint96 remaining = _freeTransfersRemaining(p.bucket);
        if (remaining == 0) return; // avoid underflow
        p.bucket.count = uint96(remaining - 1);
        p.bucket.lastTimestamp = uint40(block.timestamp);
    }

    /// @notice Not supported. This registry uses only tracked sponsorship, not fund-based sponsorship.
    function deductFees(bytes32 /*fundId*/, uint256 /*fee*/) external pure {
        revert NotSupported();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
