// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ISFC} from "../interfaces/ISFC.sol";
import {ConstantsManager} from "./ConstantsManager.sol";
import {Decimal} from "../common/Decimal.sol";

/**
 * @custom:security-contact security@fantom.foundation
 */
contract ConstantsMigrator {
    event MigratedTo(address target);

    function deployAndMigrate(address _sfc) external {
        // prep the source and target contracts
        ConstantsManager source = ConstantsManager(ISFC(_sfc).constsAddress());
        ConstantsManager target = new ConstantsManager(address(this));

        // transfer the current values
        target.updateMinSelfStake(source.minSelfStake());
        target.updateMaxDelegatedRatio(source.maxDelegatedRatio());
        target.updateValidatorCommission(source.validatorCommission());
        target.updateBurntFeeShare(source.burntFeeShare());
        target.updateTreasuryFeeShare(source.treasuryFeeShare());
        target.updateWithdrawalPeriodEpochs(source.withdrawalPeriodEpochs());
        target.updateWithdrawalPeriodTime(source.withdrawalPeriodTime());
        target.updateBaseRewardPerSecond(source.baseRewardPerSecond());
        target.updateOfflinePenaltyThresholdTime(source.offlinePenaltyThresholdTime());
        target.updateOfflinePenaltyThresholdBlocksNum(source.offlinePenaltyThresholdBlocksNum());
        target.updateAverageUptimeEpochWindow(source.averageUptimeEpochWindow());
        target.updateMinAverageUptime(source.minAverageUptime());
        target.updateIssuedTokensRecipient(source.issuedTokensRecipient());

        // set the newly added constants to their default values
        // these are not expected to be present in the previous contract version and can not be transferred
        target.updateExtraRewardsBurnRatio((60 * Decimal.unit()) / 100); // 60% burn

        // pass the new constants contract ownership to mirror the source
        target.transferOwnership(source.owner());
        emit MigratedTo(address(target));
    }
}