// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISubsidiesExtension} from "../interfaces/ISubsidiesExtension.sol";
import {SUBSIDY_MODE_NONE, SUBSIDY_MODE_TRACKED} from "../interfaces/ISubsidiesRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Version} from "../version/Version.sol";

/**
 * @title Free Transfers Subsidy Extension
 * @notice Registry allowing to sponsor ERC-20 transfers on registered tokens.
 *         The amount of sponsored transactions is rate-limited per token via a leaky bucket.
 * @custom:security-contact security@fantom.foundation
 */
contract FreeTransfersSubsidyExtension is ISubsidiesExtension, OwnableUpgradeable, UUPSUpgradeable, Version {
    struct LeakyBucket {
        // uint40 + uint96 + uint96 = 29 bytes, fits in 1 slot
        uint40 lastTimestamp; // the last update of count
        uint96 count; // current level of the bucket (at lastTimestamp)
        uint96 dailyLimit; // maximum bucket level, refilled at a rate of limit per day
    }

    // only the SubsidiesRegistry contract is allowed to call track()
    address private constant SUBSIDIES_REGISTRY = 0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2;

    /// top-byte prefix embedded in tracking IDs to identify this contract's tracked transactions
    bytes32 private constant TRACKING_ID_PREFIX = bytes32(uint256(0xF7) << 248);

    /// @notice Maps an ERC-20 token address to its leaky bucket.
    mapping(address token => LeakyBucket) private tokenToBucket;

    event TokenRegistered(address indexed token, uint96 dailyLimit);
    event FreeTransfersDailyLimitChanged(address indexed token, uint96 newDailyLimit);
    event TokenRemoved(address indexed token);

    error TokenAlreadyRegistered();
    error TokenNotRegistered();
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

    /// @notice Register an ERC-20 token and set its daily free transfer limit.
    function registerToken(address token, uint96 dailyLimit) external onlyOwner {
        require(tokenToBucket[token].lastTimestamp == 0, TokenAlreadyRegistered());
        tokenToBucket[token] = LeakyBucket({
            lastTimestamp: uint40(block.timestamp),
            count: dailyLimit,
            dailyLimit: dailyLimit
        });
        emit TokenRegistered(token, dailyLimit);
    }

    /// @notice Remove an ERC-20 token from the sponsored token list.
    function removeToken(address token) external onlyOwner {
        require(tokenToBucket[token].lastTimestamp != 0, TokenNotRegistered());
        delete tokenToBucket[token];
        emit TokenRemoved(token);
    }

    /// @notice Update the daily free transfer limit for a token. Set to 0 to effectively pause it.
    function setFreeTransfersDailyLimit(address token, uint96 dailyLimit) external onlyOwner {
        require(tokenToBucket[token].lastTimestamp != 0, TokenNotRegistered());
        tokenToBucket[token].dailyLimit = dailyLimit;
        tokenToBucket[token].count = dailyLimit;
        tokenToBucket[token].lastTimestamp = uint40(block.timestamp);
        emit FreeTransfersDailyLimitChanged(token, dailyLimit);
    }

    /// @notice Returns the number of free ERC-20 transfers currently available for a token.
    function freeTransfersRemaining(address token) external view returns (uint256) {
        require(tokenToBucket[token].lastTimestamp != 0, TokenNotRegistered());
        return _freeTransfersRemaining(tokenToBucket[token]);
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

    /// @notice Check if a transaction is covered by a token subsidy and return the tracking ID.
    /// @dev The Sonic node guarantees that chooseFund, the sponsored transaction itself, and the
    ///      subsequent track() call are never interleaved with other sponsored transactions of the
    ///      same token. Bucket consistency therefore does not require on-chain mutual exclusion.
    /// @param to Transaction recipient (the ERC-20 token contract)
    /// @param callData Transaction call data
    /// @return mode SUBSIDY_MODE_TRACKED if sponsored, SUBSIDY_MODE_NONE otherwise.
    /// @return payload Tracking ID encoding the 0xF7 prefix and the token address, zero otherwise.
    function chooseFund(
        address /*from*/,
        address to,
        uint256 /*value*/,
        uint256 /*nonce*/,
        bytes calldata callData,
        uint256 /*fee*/
    ) external view returns (uint256 mode, bytes32 payload) {
        if (callData.length == 68 && bytes4(callData[:4]) == IERC20.transfer.selector) {
            LeakyBucket storage bucket = tokenToBucket[to];
            if (bucket.lastTimestamp == 0) return (SUBSIDY_MODE_NONE, bytes32(0));
            if (_freeTransfersRemaining(bucket) < 1) {
                return (SUBSIDY_MODE_NONE, bytes32(0)); // rate limit reached
            }
            return (SUBSIDY_MODE_TRACKED, TRACKING_ID_PREFIX | bytes32(uint256(uint160(to))));
        }

        return (SUBSIDY_MODE_NONE, bytes32(0));
    }

    /// @notice Consume one free transfer from the token's bucket after a sponsored transaction.
    /// @dev Intended to be called only by SubsidiesRegistry, which forwards the call from the Sonic node.
    /// @param trackingId Tracking ID returned by chooseFund, encoding the 0xF7 prefix and token address.
    function track(bytes32 trackingId, uint256 /*fee*/) external {
        require(msg.sender == SUBSIDIES_REGISTRY, NotNode());
        require(trackingId & bytes32(uint256(0xFF) << 248) == TRACKING_ID_PREFIX, InvalidTrackingId());
        address token = address(uint160(uint256(trackingId)));
        LeakyBucket storage bucket = tokenToBucket[token];
        uint96 remaining = _freeTransfersRemaining(bucket);
        if (remaining == 0) return; // avoid underflow
        bucket.count = uint96(remaining - 1);
        bucket.lastTimestamp = uint40(block.timestamp);
    }

    /// @notice Not supported. This registry uses only tracked sponsorship, not fund-based sponsorship.
    function deductFees(bytes32 /*fundId*/, uint256 /*fee*/) external pure {
        revert NotSupported();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
