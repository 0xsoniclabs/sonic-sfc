// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ConstantsManager} from "../sfc/ConstantsManager.sol";
import {ISFC} from "../interfaces/ISFC.sol";
import {Decimal} from "../common/Decimal.sol";

contract StubSFC {
    address public immutable owner;
    ConstantsManager internal c;

    event BurntNativeTokens(uint256 amount);

    constructor(address _owner) {
        owner = _owner;
    }

    function burnNativeTokens() external payable {
        emit BurntNativeTokens(msg.value);
    }

    function constsAddress() external view returns (address) {
        return address(c);
    }

    function updateConstsAddress(address v) external {
        c = ConstantsManager(v);
    }
}

contract StubNetworkInitializer {
    function initializeAll(address payable _stubSFC, address _owner) external {
        ConstantsManager consts = new ConstantsManager(address(this));

        consts.updateMinSelfStake(500_000 * Decimal.unit());
        consts.updateMaxDelegatedRatio(16 * Decimal.unit());
        consts.updateValidatorCommission((15 * Decimal.unit()) / 100);
        consts.updateBurntFeeShare((20 * Decimal.unit()) / 100);
        consts.updateTreasuryFeeShare((10 * Decimal.unit()) / 100);
        consts.updateExtraRewardsBurnRatio((60 * Decimal.unit()) / 100);
        consts.updateWithdrawalPeriodEpochs(3);
        consts.updateWithdrawalPeriodTime(60 * 60 * 24 * 7);
        consts.updateBaseRewardPerSecond(1_000);
        consts.updateOfflinePenaltyThresholdTime(5 days);
        consts.updateOfflinePenaltyThresholdBlocksNum(1_000);
        consts.updateAverageUptimeEpochWindow(100);
        consts.updateMinAverageUptime(uint64((Decimal.unit() * 2) / 10));
        consts.updateIssuedTokensRecipient(_owner);

        consts.transferOwnership(_owner);

        ISFC(_stubSFC).updateConstsAddress(address(consts));
    }
}
