// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISubsidiesExtension} from "../interfaces/ISubsidiesExtension.sol";
import {SUBSIDY_MODE_NONE, SUBSIDY_MODE_TRACKED} from "../interfaces/ISubsidiesRegistry.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Version} from "../version/Version.sol";

/**
 * @title Sender Project Subsidies
 * @notice Subsidies extension allowing registered senders to make free transfers of whitelisted
 *         ERC-20 tokens and free native pure transfers. Senders are grouped into projects; each
 *         project shares one leaky-bucket rate limit regardless of the transferred token.
 * @custom:security-contact security@fantom.foundation
 */
contract SenderProjectSubsidies is ISubsidiesExtension, AccessControlUpgradeable, UUPSUpgradeable, Version {
    struct LeakyBucket {
        // uint40 + uint96 + uint96 = 29 bytes, fits in 1 slot
        uint40 lastTimestamp; // the last update of count
        uint96 count; // current level of the bucket (at lastTimestamp)
        uint96 dailyLimit; // maximum bucket level, refilled at a rate of limit per day
    }

    /// @notice Role allowed to register/remove projects and set their daily limits.
    bytes32 public constant PROJECT_MANAGER_ROLE = keccak256("PROJECT_MANAGER_ROLE");

    /// @notice Role allowed to add/remove senders of projects.
    bytes32 public constant SENDER_MANAGER_ROLE = keccak256("SENDER_MANAGER_ROLE");

    /// @notice Role allowed to manage the whitelist of sponsorable tokens.
    bytes32 public constant WHITELIST_MANAGER_ROLE = keccak256("WHITELIST_MANAGER_ROLE");

    /// @notice Sentinel representing the native token in the token whitelist.
    ///         Whitelisting it enables sponsoring of native pure transfers.
    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // only the SubsidiesRegistry contract is allowed to call track()
    address private constant SUBSIDIES_REGISTRY = 0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2;

    /// top-byte prefix embedded in tracking IDs to identify this contract's tracked transactions
    bytes32 private constant TRACKING_ID_PREFIX = bytes32(uint256(0xF6) << 248);

    mapping(uint32 projectId => LeakyBucket) private projectBuckets;

    /// @notice Maps a sender address to its project ID. Project ID 0 means not registered.
    mapping(address sender => uint32 projectId) public senderToProject;

    /// @notice Tokens whose transfers can be sponsored. Use NATIVE_TOKEN for native pure transfers.
    mapping(address token => bool) public whitelistedTokens;

    event ProjectRegistered(uint32 indexed projectId, uint96 dailyLimit);
    event ProjectRemoved(uint32 indexed projectId);
    event DailyLimitChanged(uint32 indexed projectId, uint96 newDailyLimit);
    event SenderAdded(uint32 indexed projectId, address indexed sender);
    event SenderRemoved(address indexed sender);
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);

    error InvalidProjectId();
    error ProjectAlreadyExists();
    error ProjectNotFound();
    error SenderAlreadyAssigned();
    error SenderNotAssigned();
    error TokenAlreadyWhitelisted();
    error TokenNotWhitelisted();
    error NotSubsidiesRegistry();
    error InvalidTrackingId();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract. DEFAULT_ADMIN_ROLE is granted to the SubsidiesRegistry owner.
    function initialize() external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, OwnableUpgradeable(SUBSIDIES_REGISTRY).owner());
    }

    /// @notice The top-byte prefix of tracking IDs issued by this extension.
    function trackingIdPrefix() external pure returns (uint8) {
        return uint8(uint256(TRACKING_ID_PREFIX) >> 248);
    }

    /// @notice Register a new project with given daily free transfers limit.
    /// @param projectId Unique 32-bit identifier. Must be non-zero.
    function registerProject(uint32 projectId, uint96 dailyLimit) external onlyRole(PROJECT_MANAGER_ROLE) {
        require(projectId != 0, InvalidProjectId());
        require(projectBuckets[projectId].lastTimestamp == 0, ProjectAlreadyExists());
        projectBuckets[projectId] = LeakyBucket({
            lastTimestamp: uint40(block.timestamp),
            count: dailyLimit,
            dailyLimit: dailyLimit
        });
        emit ProjectRegistered(projectId, dailyLimit);
    }

    /// @notice Remove a project. Senders still mapped to this project will no longer be sponsored.
    function removeProject(uint32 projectId) external onlyRole(PROJECT_MANAGER_ROLE) {
        require(projectBuckets[projectId].lastTimestamp != 0, ProjectNotFound());
        delete projectBuckets[projectId];
        emit ProjectRemoved(projectId);
    }

    /// @notice Update the daily free transfer limit for a project. Set to 0 to effectively pause it.
    function setDailyLimit(uint32 projectId, uint96 dailyLimit) external onlyRole(PROJECT_MANAGER_ROLE) {
        require(projectBuckets[projectId].lastTimestamp != 0, ProjectNotFound());
        projectBuckets[projectId] = LeakyBucket({
            lastTimestamp: uint40(block.timestamp),
            count: dailyLimit,
            dailyLimit: dailyLimit
        });
        emit DailyLimitChanged(projectId, dailyLimit);
    }

    /// @notice Returns the number of free transfers currently available for a project.
    function freeTransfersRemaining(uint32 projectId) external view returns (uint256) {
        require(projectBuckets[projectId].lastTimestamp != 0, ProjectNotFound());
        return _freeTransfersRemaining(projectBuckets[projectId]);
    }

    /// @notice Add a sender to a project, allowing it to make sponsored transfers.
    function addSender(uint32 projectId, address sender) external onlyRole(SENDER_MANAGER_ROLE) {
        require(projectBuckets[projectId].lastTimestamp != 0, ProjectNotFound());
        require(senderToProject[sender] == 0, SenderAlreadyAssigned());
        senderToProject[sender] = projectId;
        emit SenderAdded(projectId, sender);
    }

    /// @notice Remove a sender from its project.
    function removeSender(address sender) external onlyRole(SENDER_MANAGER_ROLE) {
        require(senderToProject[sender] != 0, SenderNotAssigned());
        delete senderToProject[sender];
        emit SenderRemoved(sender);
    }

    /// @notice Add a token to the whitelist of sponsorable transfers.
    ///         Use NATIVE_TOKEN to enable sponsoring of native pure transfers.
    function whitelistToken(address token) external onlyRole(WHITELIST_MANAGER_ROLE) {
        require(!whitelistedTokens[token], TokenAlreadyWhitelisted());
        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token);
    }

    /// @notice Remove a token from the whitelist of sponsorable transfers.
    function removeTokenFromWhitelist(address token) external onlyRole(WHITELIST_MANAGER_ROLE) {
        require(whitelistedTokens[token], TokenNotWhitelisted());
        delete whitelistedTokens[token];
        emit TokenRemovedFromWhitelist(token);
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

    function _trySponsor(uint32 projectId) private view returns (uint256 mode, bytes32 payload) {
        if (projectId == 0) return (SUBSIDY_MODE_NONE, bytes32(0));
        LeakyBucket storage bucket = projectBuckets[projectId];
        if (bucket.lastTimestamp == 0) return (SUBSIDY_MODE_NONE, bytes32(0)); // project removed
        // the refill needs to be computed only for an empty bucket
        if (bucket.count == 0 && _freeTransfersRemaining(bucket) == 0) {
            return (SUBSIDY_MODE_NONE, bytes32(0)); // rate limit reached
        }
        return (SUBSIDY_MODE_TRACKED, TRACKING_ID_PREFIX | bytes32(uint256(projectId)));
    }

    /// @notice Check if a transaction is a whitelisted-token or native pure transfer from a
    ///         registered sender and return the tracking ID of the sender's project.
    /// @dev The Sonic node guarantees that chooseFund, the sponsored transaction itself, and the
    ///      subsequent track() call are never interleaved with other sponsored transactions of the
    ///      same project. Bucket consistency therefore does not require on-chain mutual exclusion.
    /// @param from Transaction sender
    /// @param to Transaction recipient
    /// @param value Transaction value
    /// @param callData Transaction call data
    /// @return mode SUBSIDY_MODE_TRACKED if sponsored, SUBSIDY_MODE_NONE otherwise.
    /// @return payload Tracking ID encoding the 0xF6 prefix and project ID, zero otherwise.
    function chooseFund(
        address from,
        address to,
        uint256 value,
        uint256 /*nonce*/,
        bytes calldata callData,
        uint256 /*fee*/
    ) external view returns (uint256 mode, bytes32 payload) {
        bool isWhitelistedTransfer = (callData.length == 68 &&
            bytes4(callData[:4]) == IERC20.transfer.selector &&
            whitelistedTokens[to]) || (callData.length == 0 && value > 0 && whitelistedTokens[NATIVE_TOKEN]);
        if (isWhitelistedTransfer) {
            return _trySponsor(senderToProject[from]);
        }
        return (SUBSIDY_MODE_NONE, bytes32(0));
    }

    /// @notice Consume one free transfer from the project's bucket after a sponsored transaction.
    /// @dev Intended to be called only by SubsidiesRegistry, which forwards the call from the Sonic node.
    /// @param trackingId Tracking ID returned by chooseFund, encoding the 0xF6 prefix and project ID.
    function track(bytes32 trackingId, uint256 /*fee*/) external {
        require(msg.sender == SUBSIDIES_REGISTRY, NotSubsidiesRegistry());
        require(trackingId & bytes32(uint256(0xFF) << 248) == TRACKING_ID_PREFIX, InvalidTrackingId());
        uint32 projectId = uint32(uint256(trackingId));
        LeakyBucket storage bucket = projectBuckets[projectId];
        uint96 remaining = _freeTransfersRemaining(bucket);
        if (remaining == 0) return; // avoid underflow
        projectBuckets[projectId] = LeakyBucket({
            lastTimestamp: uint40(block.timestamp),
            count: remaining - 1,
            dailyLimit: bucket.dailyLimit
        });
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
