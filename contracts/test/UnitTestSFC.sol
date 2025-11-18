// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Decimal} from "../common/Decimal.sol";
import {SFC} from "../sfc/SFC.sol";
import {ISFC} from "../interfaces/ISFC.sol";
import {NodeDriverAuth} from "../sfc/NodeDriverAuth.sol";
import {NodeDriver} from "../sfc/NodeDriver.sol";

contract UnitTestSFC is SFC {
    uint256 internal time;
    bool public allowedNonNodeCalls;

    function rebaseTime() external {
        time = block.timestamp;
    }

    function advanceTime(uint256 diff) external {
        time += diff;
    }

    function getTime() external view returns (uint256) {
        return time;
    }

    function getBlockTime() external view returns (uint256) {
        return block.timestamp;
    }

    function enableNonNodeCalls() external {
        allowedNonNodeCalls = true;
    }

    function disableNonNodeCalls() external {
        allowedNonNodeCalls = false;
    }

    function _now() internal view override returns (uint256) {
        return time;
    }

    function _isNodeDriverAuth(address addr) internal view override returns (bool) {
        if (allowedNonNodeCalls) {
            return true;
        }
        return SFC._isNodeDriverAuth(addr);
    }

    function syncValidator(uint256 validatorID, bool syncPubkey) public {
        _syncValidator(validatorID, syncPubkey);
    }
}
