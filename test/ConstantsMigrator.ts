import { ethers } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ConstantsMigrator, UnitTestConstantsManager, StubNetworkInitializer } from '../typechain-types';

describe('ConstantsMigrator', () => {
  const fixture = async () => {
    const [owner, nonOwner] = await ethers.getSigners();

    // Deploy a stub SFC contract to copy code from and set at the SFC address
    const stubSfc = await ethers.deployContract('StubSFC', [owner]);
    const initializer: StubNetworkInitializer = await ethers.deployContract('StubNetworkInitializer');
    await initializer.initializeAll(stubSfc, owner);

    const srcConstants: UnitTestConstantsManager = await ethers.getContractAt(
      'UnitTestConstantsManager',
      await stubSfc.constsAddress(),
    );

    // Deploy the migrator contract to be tested
    const migrator: ConstantsMigrator = await ethers.deployContract('ConstantsMigrator', []);

    return {
      owner,
      nonOwner,
      stubSfc,
      srcConstants,
      migrator,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  describe('SFC Constants Migration', () => {
    it('Should succeed and migrate', async function () {
      // execute the migration and get the new constants address
      const tx = await this.migrator.deployAndMigrate(this.stubSfc);
      await expect(tx).to.emit(this.migrator, 'MigratedTo');

      const result = await tx.wait();
      const targetAddress = result.logs?.find((e: { fragment: { name: string } }) => e.fragment?.name === 'MigratedTo')
        ?.args?.[0];

      const targetConstants: UnitTestConstantsManager = await ethers.getContractAt(
        'UnitTestConstantsManager',
        targetAddress,
      );

      // the new constants owner should be the same as the source constants owner
      expect(await targetConstants.owner()).to.equal(this.owner);

      // all the values should be the same as the source constants
      expect(await targetConstants.minSelfStake()).to.equal(await this.srcConstants.minSelfStake());
      expect(await targetConstants.maxDelegatedRatio()).to.equal(await this.srcConstants.maxDelegatedRatio());
      expect(await targetConstants.validatorCommission()).to.equal(await this.srcConstants.validatorCommission());
      expect(await targetConstants.burntFeeShare()).to.equal(await this.srcConstants.burntFeeShare());
      expect(await targetConstants.treasuryFeeShare()).to.equal(await this.srcConstants.treasuryFeeShare());
      expect(await targetConstants.extraRewardsBurnRatio()).to.equal(await this.srcConstants.extraRewardsBurnRatio());
      expect(await targetConstants.withdrawalPeriodEpochs()).to.equal(await this.srcConstants.withdrawalPeriodEpochs());
      expect(await targetConstants.withdrawalPeriodTime()).to.equal(await this.srcConstants.withdrawalPeriodTime());
      expect(await targetConstants.baseRewardPerSecond()).to.equal(await this.srcConstants.baseRewardPerSecond());
      expect(await targetConstants.offlinePenaltyThresholdBlocksNum()).to.equal(
        await this.srcConstants.offlinePenaltyThresholdBlocksNum(),
      );
      expect(await targetConstants.offlinePenaltyThresholdTime()).to.equal(
        await this.srcConstants.offlinePenaltyThresholdTime(),
      );
      expect(await targetConstants.averageUptimeEpochWindow()).to.equal(
        await this.srcConstants.averageUptimeEpochWindow(),
      );
      expect(await targetConstants.minAverageUptime()).to.equal(await this.srcConstants.minAverageUptime());
      expect(await targetConstants.issuedTokensRecipient()).to.equal(await this.srcConstants.issuedTokensRecipient());
    });
  });
});
