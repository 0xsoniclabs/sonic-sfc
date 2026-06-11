// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ISubsidiesExtension} from "../interfaces/ISubsidiesExtension.sol";
import {SUBSIDY_MODE_NONE, SUBSIDY_MODE_TRACKED} from "../interfaces/ISubsidiesRegistry.sol";

/// @dev Test stub with a configurable tracking ID prefix and chooseFund behavior.
///      Records the last track call.
contract StubSubsidyExtension is ISubsidiesExtension {
    uint8 private immutable PREFIX;
    bool private immutable SPONSOR_EVERYTHING;

    bytes32 public lastTrackingId;
    bool public trackCalled;

    constructor(uint8 prefix, bool sponsorEverything) {
        PREFIX = prefix;
        SPONSOR_EVERYTHING = sponsorEverything;
    }

    function trackingIdPrefix() external view returns (uint8) {
        return PREFIX;
    }

    function chooseFund(
        address,
        address,
        uint256,
        uint256,
        bytes calldata,
        uint256
    ) external view returns (uint256 mode, bytes32 payload) {
        if (!SPONSOR_EVERYTHING) {
            return (SUBSIDY_MODE_NONE, bytes32(0));
        }
        return (SUBSIDY_MODE_TRACKED, bytes32(uint256(PREFIX) << 248) | bytes32(uint256(1)));
    }

    function track(bytes32 trackingId, uint256) external {
        lastTrackingId = trackingId;
        trackCalled = true;
    }
}
