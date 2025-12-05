import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ConstantsManager, IEVMWriter, NetworkInitializer } from '../typechain-types';
import { beforeEach, Context } from 'mocha';
import { BlockchainNode, ValidatorMetrics } from './helpers/BlockchainNode';

describe('SFC', () => {
  const fixture = async () => {
    const [owner, user] = await ethers.getSigners();
    const totalSupply = ethers.parseEther('5000');
    const sfc = await upgrades.deployProxy(await ethers.getContractFactory('UnitTestSFC'), {
      kind: 'uups',
      initializer: false,
    });
    const nodeDriver = await upgrades.deployProxy(await ethers.getContractFactory('NodeDriver'), {
      kind: 'uups',
      initializer: false,
    });
    const nodeDriverAuth = await upgrades.deployProxy(await ethers.getContractFactory('NodeDriverAuth'), {
      kind: 'uups',
      initializer: false,
    });

    const evmWriter: IEVMWriter = await ethers.deployContract('StubEvmWriter');
    const initializer: NetworkInitializer = await ethers.deployContract('NetworkInitializer');

    await initializer.initializeAll(0, totalSupply, sfc, nodeDriverAuth, nodeDriver, evmWriter, owner);
    const constants: ConstantsManager = await ethers.getContractAt('ConstantsManager', await sfc.constsAddress());
    await constants.updateMinSelfStake(ethers.parseEther('100000'));
    await sfc.rebaseTime();

    const pubKey1 =
      '0xc0040220af695ae100c370c7acff4f57e5a0c507abbbc8ac6cc2ae0ce3a81747e0cd3c6892233faae1af5d982d05b1c13a0ad4449685f0b5a6138b301cc5263f8316';
    const pubKey2 =
      '0xc00499a876465bc626061bb2f0326df1a223c14e3bcdc3fff3deb0f95f316b9d586b03f00bbc2349be3d7908de8626cfd8f7fd6f73bff49df1299f44b6855562c33d';
    const pubKey3 =
      '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc5252';
    const pubKeyAddress1 = '0x65Db23D0c4FA8Ec58151a30E54e6a6046c97cD10';
    const pubKeyAddress2 = '0x1AA3196683eE97Adf5B398875828E322a34E8085';

    await ethers.provider.send('hardhat_impersonateAccount', [await nodeDriverAuth.getAddress()]);
    const sfcAsNode = sfc.connect(await ethers.getImpersonatedSigner(await nodeDriverAuth.getAddress()));

    const [validator1, validator2, validator3, delegator1, delegator2, delegator3] = await ethers.getSigners();

    for (const account of [validator1, validator2, validator3, delegator1, delegator2, delegator3, nodeDriverAuth]) {
      await ethers.provider.send('hardhat_setBalance', [
        await account.getAddress(),
        ethers.toBeHex(ethers.parseEther('10000000')),
      ]);
    }

    return {
      owner,
      user,
      sfc,
      evmWriter,
      nodeDriver,
      nodeDriverAuth,
      constants,
      totalSupply,
      pubKey1,
      pubKey2,
      pubKey3,
      pubKeyAddress1,
      pubKeyAddress2,
      sfcAsNode,
      validator1,
      validator2,
      validator3,
      delegator1,
      delegator2,
      delegator3,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Should revert when amount sent', async function () {
    await expect(
      this.owner.sendTransaction({
        to: this.sfc,
        value: 1,
      }),
    ).to.revertedWithCustomError(this.sfc, 'TransfersNotAllowed');
  });

  describe('Burn native tokens', () => {
    it('Should revert when no amount sent', async function () {
      await expect(this.sfc.connect(this.user).burnNativeTokens()).to.be.revertedWithCustomError(
        this.sfc,
        'ZeroAmount',
      );
    });

    it('Should revert when amount greater than total supply', async function () {
      await expect(
        this.sfc.connect(this.user).burnNativeTokens({ value: (await this.sfc.totalSupply()) + 1n }),
      ).to.be.revertedWithCustomError(this.sfc, 'ValueTooLarge');
    });

    it('Should succeed and burn native tokens', async function () {
      const amount = ethers.parseEther('1.5');
      const totalSupply = await this.sfc.totalSupply();
      const tx = await this.sfc.connect(this.user).burnNativeTokens({ value: amount });
      await expect(tx).to.emit(this.sfc, 'BurntNativeTokens').withArgs(amount);
      expect(await this.sfc.totalSupply()).to.equal(totalSupply - amount);
      await expect(tx).to.changeEtherBalance(this.sfc, 0);
      await expect(tx).to.changeEtherBalance(this.user, -amount);
      await expect(tx).to.changeEtherBalance(ethers.ZeroAddress, amount);
    });
  });

  describe('Node calls', () => {
    it('Sets genesis validator and deactivates it', async function () {
      const offlineStatus = 1 << 3;
      const creationTime = 12345;
      await this.sfcAsNode.setGenesisValidator(this.validator1.address, 1, this.pubKey1, creationTime);
      await this.sfcAsNode.deactivateValidator(1, offlineStatus);

      const latestBlock = await ethers.provider.getBlock('latest');
      const validatorStruct = await this.sfc.getValidator(1);
      expect(validatorStruct.status).to.equal(offlineStatus);
      expect(validatorStruct.deactivatedTime).to.be.within(latestBlock!.timestamp - 10, latestBlock!.timestamp);
      expect(validatorStruct.deactivatedEpoch).to.equal(1);
      expect(validatorStruct.receivedStake).to.equal(0);
      expect(validatorStruct.createdEpoch).to.equal(0);
      expect(validatorStruct.createdTime).to.equal(creationTime);
      expect(validatorStruct.auth).to.equal(this.validator1.address);
    });

    it('Reverts when not called by node', async function () {
      await expect(this.sfc.sealEpoch([1], [1], [1], [1])).to.be.revertedWithCustomError(this.sfc, 'NotDriverAuth');
      await expect(this.sfc.sealEpochValidators([1])).to.be.revertedWithCustomError(this.sfc, 'NotDriverAuth');
      await expect(
        this.sfc.setGenesisValidator(this.validator1, 1, this.pubKey1, Date.now()),
      ).to.be.revertedWithCustomError(this.sfc, 'NotDriverAuth');
      await expect(this.sfc.setGenesisDelegation(this.delegator1, 1, 100)).to.be.revertedWithCustomError(
        this.sfc,
        'NotDriverAuth',
      );
      await expect(this.sfc.deactivateValidator(1, 0)).to.be.revertedWithCustomError(this.sfc, 'NotDriverAuth');
    });
  });

  describe('Constants', () => {
    it('Should succeed and return now()', async function () {
      const block = await ethers.provider.getBlock('latest');
      expect(block).to.not.be.equal(null);
      expect(await this.sfc.getBlockTime()).to.be.within(block!.timestamp - 100, block!.timestamp + 100);
    });

    it('Should succeed and return getTime()', async function () {
      const block = await ethers.provider.getBlock('latest');
      expect(block).to.not.be.equal(null);
      expect(await this.sfc.getTime()).to.be.within(block!.timestamp - 100, block!.timestamp + 100);
    });

    it('Should succeed and return current epoch', async function () {
      expect(await this.sfc.currentEpoch()).to.equal(1);
    });

    it('Should succeed and return current sealed epoch', async function () {
      expect(await this.sfc.currentSealedEpoch()).to.equal(0);
    });

    it('Should succeed and return minimum amount to stake for validator', async function () {
      await this.constants.updateMinSelfStake(ethers.parseEther('100000.2'));
      expect(await this.constants.minSelfStake()).to.equal(ethers.parseEther('100000.2'));
    });

    it('Should succeed and return maximum ratio of delegations a validator can have', async function () {
      await this.constants.updateMaxDelegatedRatio(ethers.parseEther('16'));
      expect(await this.constants.maxDelegatedRatio()).to.equal(ethers.parseEther('16'));
    });

    it('Should succeed and return commission fee in percentage a validator will get from a delegation', async function () {
      await this.constants.updateValidatorCommission(ethers.parseEther('0.15'));
      expect(await this.constants.validatorCommission()).to.equal(ethers.parseEther('0.15'));
    });

    it('Should succeed and return burnt fee share', async function () {
      await this.constants.updateBurntFeeShare(ethers.parseEther('0.05'));
      expect(await this.constants.burntFeeShare()).to.equal(ethers.parseEther('0.05'));
    });

    it('Should succeed and return treasury fee share', async function () {
      await this.constants.updateTreasuryFeeShare(ethers.parseEther('0.1'));
      expect(await this.constants.treasuryFeeShare()).to.equal(ethers.parseEther('0.1'));
    });

    it('Should succeed and return period of time that stake is locked', async function () {
      await this.constants.updateWithdrawalPeriodTime(60 * 60 * 24 * 7);
      expect(await this.constants.withdrawalPeriodTime()).to.equal(60 * 60 * 24 * 7);
    });

    it('Should succeed and return number of epochs that stake is locked', async function () {
      await this.constants.updateWithdrawalPeriodEpochs(3);
      expect(await this.constants.withdrawalPeriodEpochs()).to.equal(3);
    });

    it('Should succeed and return version of the current implementation', async function () {
      expect(await this.sfc.version()).to.equal('0x040005');
    });
  });

  describe('Issue tokens', () => {
    it('Should revert when not owner', async function () {
      await expect(this.sfc.connect(this.user).issueTokens(ethers.parseEther('100'))).to.be.revertedWithCustomError(
        this.sfc,
        'OwnableUnauthorizedAccount',
      );
    });

    it('Should revert when recipient is not set', async function () {
      await expect(this.sfc.connect(this.owner).issueTokens(ethers.parseEther('100'))).to.be.revertedWithCustomError(
        this.sfc,
        'ZeroAddress',
      );
    });

    it('Should succeed and issue tokens', async function () {
      await this.constants.updateIssuedTokensRecipient(this.user);
      const supply = await this.sfc.totalSupply();
      const amount = ethers.parseEther('100');
      const expectedNewBalance = (await ethers.provider.getBalance(this.user)) + amount;
      await expect(this.sfc.connect(this.owner).issueTokens(amount))
        .to.emit(this.evmWriter, 'EvmWriterSetBalance')
        .withArgs(this.user, expectedNewBalance);
      expect(await this.sfc.totalSupply()).to.equal(supply + amount);
    });
  });

  describe('Create validator', () => {
    it('Creates a validator', async function () {
      await expect(
        this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100004') }),
      )
        .to.emit(this.sfc, 'CreatedValidator')
        .withArgs(1, this.validator1, anyValue, anyValue);

      expect(await this.sfc.lastValidatorID()).to.equal(1);
      const validatorStruct = await this.sfc.getValidator(1);
      expect(validatorStruct.status).to.equal(0);
      expect(validatorStruct.deactivatedTime).to.equal(0);
      expect(validatorStruct.deactivatedEpoch).to.equal(0);
      expect(validatorStruct.receivedStake).to.equal(ethers.parseEther('100004'));
      expect(validatorStruct.createdEpoch).to.equal(1);
      const latestBlock = await ethers.provider.getBlock('latest');
      expect(validatorStruct.createdTime).to.be.within(latestBlock!.timestamp - 5, latestBlock!.timestamp);
      expect(validatorStruct.auth).to.equal(this.validator1.address);

      expect(await this.sfc.pubkeyAddressToValidatorID(this.pubKeyAddress1)).to.equal(1);
      expect(await this.sfc.getValidatorPubkey(1)).to.equal(this.pubKey1);
      expect(await this.sfc.getStake(this.validator1, 1)).to.equal(ethers.parseEther('100004'));
    });

    it('Rejects to create a validator with insufficient self-stake', async function () {
      await expect(
        this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('0.1') }),
      ).to.be.revertedWithCustomError(this.sfc, 'InsufficientSelfStake');
    });

    it('Rejects empty validator public key', async function () {
      await expect(
        this.sfc.connect(this.validator1).createValidator('0x', { value: ethers.parseEther('100004') }),
      ).to.be.revertedWithCustomError(this.sfc, 'MalformedPubkey');
    });

    it('Rejects a duplicate public key', async function () {
      this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100004') });
      await expect(
        this.sfc.connect(this.validator2).createValidator(this.pubKey1, { value: ethers.parseEther('100005') }),
      ).to.be.revertedWithCustomError(this.sfc, 'PubkeyUsedByOtherValidator');
    });

    it('Rejects to create a validator if the user already have one', async function () {
      this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100004') });
      await expect(
        this.sfc.connect(this.validator1).createValidator(this.pubKey2, { value: ethers.parseEther('100005') }),
      ).to.be.revertedWithCustomError(this.sfc, 'ValidatorExists');
    });

    it('Creates two validators and returns correct last validator id', async function () {
      expect(await this.sfc.lastValidatorID()).to.equal(0);
      expect(await this.sfc.getValidatorID(this.validator1)).to.equal(0);
      expect(await this.sfc.getValidatorID(this.validator2)).to.equal(0);

      await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100004') });
      expect(await this.sfc.getValidatorID(this.validator1)).to.equal(1);
      expect(await this.sfc.lastValidatorID()).to.equal(1);

      await this.sfc.connect(this.validator2).createValidator(this.pubKey2, { value: ethers.parseEther('100005') });
      expect(await this.sfc.getValidatorID(this.validator2)).to.equal(2);
      expect(await this.sfc.lastValidatorID()).to.equal(2);
    });

    it('Allows to delegate to a validator', async function () {
      await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100005') });
      await this.sfc.connect(this.delegator1).delegate(1, { value: ethers.parseEther('0.1') });

      const validatorStruct = await this.sfc.getValidator(1);
      expect(validatorStruct.receivedStake).to.equal(ethers.parseEther('100005.1'));
      expect(await this.sfc.totalActiveStake()).to.equal(ethers.parseEther('100005.1'));
    });

    it('Rejects staking to a not-existing validator', async function () {
      await expect(
        this.sfc.connect(this.delegator1).delegate(5, { value: ethers.parseEther('0.1') }),
      ).to.be.revertedWithCustomError(this.sfc, 'ValidatorNotExists');
    });

    it('Allows a single delegator to delegate to multiple validators', async function () {
      await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100005') });
      await this.sfc.connect(this.delegator1).delegate(1, { value: ethers.parseEther('10') });

      await this.sfc.connect(this.validator2).createValidator(this.pubKey2, { value: ethers.parseEther('100006') });
      await this.sfc.connect(this.delegator1).delegate(2, { value: ethers.parseEther('20') });
      await this.sfc.connect(this.delegator1).delegate(2, { value: ethers.parseEther('30') });

      expect(await this.sfc.getStake(this.delegator1, 1)).to.equal(ethers.parseEther('10'));
      expect(await this.sfc.getStake(this.delegator1, 2)).to.equal(ethers.parseEther('50'));
      expect(await this.sfc.totalActiveStake()).to.equal(ethers.parseEther('200071'));
    });
  });

  describe('SFC ownership', () => {
    it('Allows to renounce ownership of SFC', async function () {
      expect(await this.sfc.owner()).to.equal(this.owner);
      await this.sfc.renounceOwnership();
      expect(await this.sfc.owner()).to.equal(ethers.ZeroAddress);
    });

    it('Allows to transfer SFC ownership to a new owner', async function () {
      expect(await this.sfc.owner()).to.equal(this.owner);
      await this.sfc.transferOwnership(this.user);
      expect(await this.sfc.owner()).to.equal(this.user);
    });

    it('Prevents non-owner to transfer ownership', async function () {
      await expect(this.sfc.connect(this.user).transferOwnership(this.user)).to.be.revertedWithCustomError(
        this.sfc,
        'OwnableUnauthorizedAccount',
      );
      await expect(this.sfc.connect(this.user).renounceOwnership()).to.be.revertedWithCustomError(
        this.sfc,
        'OwnableUnauthorizedAccount',
      );
    });

    it('Prevents transferring ownership to the zero address', async function () {
      await expect(this.sfc.transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(this.sfc, 'OwnableInvalidOwner')
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe('Validator', () => {
    const validatorsFixture = async function (this: Context) {
      await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('100000') });
      await this.sfc.connect(this.delegator1).delegate(1, { value: ethers.parseEther('11') });
      await this.sfc.connect(this.delegator2).delegate(1, { value: ethers.parseEther('8') });
      await this.sfc.connect(this.delegator3).delegate(1, { value: ethers.parseEther('8') });
      return {};
    };

    beforeEach(async function () {
      return Object.assign(this, await loadFixture(validatorsFixture.bind(this)));
    });

    describe('Epoch sealing', () => {
      it('Increments current epoch/current sealed epoch number', async function () {
        expect(await this.sfc.currentEpoch()).to.equal(1);
        expect(await this.sfc.currentSealedEpoch()).to.equal(0);
        await this.sfcAsNode.sealEpoch([100, 101, 102], [100, 101, 102], [100, 101, 102], [100, 101, 102]);
        expect(await this.sfc.currentEpoch()).to.equal(2);
        expect(await this.sfc.currentSealedEpoch()).to.equal(1);
        for (let i = 0; i < 4; i++) {
          await this.sfcAsNode.sealEpoch([100, 101, 102], [100, 101, 102], [100, 101, 102], [100, 101, 102]);
        }
        expect(await this.sfc.currentEpoch()).to.equal(6);
        expect(await this.sfc.currentSealedEpoch()).to.equal(5);
      });

      it('Sets endBlock of the epoch correctly', async function () {
        const epochNumber = await this.sfc.currentEpoch();
        await this.sfcAsNode.sealEpoch([100, 101, 102], [100, 101, 102], [100, 101, 102], [100, 101, 102]);
        const lastBlock = await ethers.provider.getBlockNumber();
        // endBlock is on second position
        expect((await this.sfc.getEpochSnapshot(epochNumber))[1]).to.equal(lastBlock);
        expect(await this.sfc.getEpochEndBlock(epochNumber)).to.equal(lastBlock);
      });
    });
  });

  describe('Sonic node communication', () => {
    it('Creates validators in the Sonic node', async function () {
      const node = new BlockchainNode(this.sfcAsNode);

      await node.handleTx(
        await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('317500') }),
      );
      await node.handleTx(
        await this.sfc.connect(this.validator2).createValidator(this.pubKey2, { value: ethers.parseEther('500000') }),
      );

      // check changes are reflected in the contract state
      expect(await this.sfc.lastValidatorID()).to.equal(2);
      expect(await this.sfc.totalStake()).to.equal(ethers.parseEther('817500'));
      expect(await this.sfc.getStake(this.validator1, 1)).to.equal(ethers.parseEther('317500'));
      expect(await this.sfc.getStake(this.validator2, 2)).to.equal(ethers.parseEther('500000'));

      // check fired node-related logs
      expect(node.nextValidatorWeights.size).to.equal(2);
      expect(node.nextValidatorWeights.get(1n)).to.equal(ethers.parseEther('317500'));
      expect(node.nextValidatorWeights.get(2n)).to.equal(ethers.parseEther('500000'));
    });

    it('Updates validators weights and seals epochs in the Sonic node', async function () {
      const node = new BlockchainNode(this.sfcAsNode);

      await node.handleTx(
        await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('300000') }),
      );
      await node.handleTx(
        await this.sfc.connect(this.validator2).createValidator(this.pubKey2, { value: ethers.parseEther('200000') }),
      );
      await node.handleTx(await this.sfc.connect(this.delegator1).delegate(2, { value: ethers.parseEther('100') }));

      await node.sealEpoch(100);

      await node.handleTx(await this.sfc.connect(this.validator1).delegate(1, { value: ethers.parseEther('10000') }));
      await node.handleTx(await this.sfc.connect(this.delegator1).undelegate(2, 1, ethers.parseEther('50')));
      await node.handleTx(
        await this.sfc.connect(this.validator3).createValidator(this.pubKey3, { value: ethers.parseEther('400000') }),
      );

      // check fired node-related logs
      expect(node.validatorWeights.size).to.equal(2);
      expect(node.validatorWeights.get(1n)).to.equal(ethers.parseEther('300000'));
      expect(node.validatorWeights.get(2n)).to.equal(ethers.parseEther('200100'));
      expect(node.nextValidatorWeights.size).to.equal(3);
      expect(node.nextValidatorWeights.get(1n)).to.equal(ethers.parseEther('310000'));
      expect(node.nextValidatorWeights.get(2n)).to.equal(ethers.parseEther('200050'));
      expect(node.nextValidatorWeights.get(3n)).to.equal(ethers.parseEther('400000'));
    });

    it('Deactivates validators in the Sonic node', async function () {
      const node = new BlockchainNode(this.sfcAsNode);

      await node.handleTx(
        await this.sfc.connect(this.validator1).createValidator(this.pubKey1, { value: ethers.parseEther('300000') }),
      );
      await node.handleTx(
        await this.sfc.connect(this.validator2).createValidator(this.pubKey2, { value: ethers.parseEther('200000') }),
      );
      await node.handleTx(await this.sfc.connect(this.delegator1).delegate(2, { value: ethers.parseEther('100') }));

      const offlineStatus = 1 << 3;
      await node.handleTx(await this.sfcAsNode.deactivateValidator(2, offlineStatus));

      // check fired node-related logs
      expect(node.nextValidatorWeights.size).to.equal(1n);
      expect(node.nextValidatorWeights.get(1n)).to.equal(ethers.parseEther('300000'));
      expect(node.totalWeight).to.equal(ethers.parseEther('300000'));
    });
  });

  describe('Staking / Sealed Epoch functions', () => {
    const validatorsFixture = async function (this: Context) {
      const [validator, secondValidator, thirdValidator, delegator, secondDelegator] = await ethers.getSigners();
      const pubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc525f';
      const secondPubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc5251';
      const thirdPubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc5252';
      const blockchainNode = new BlockchainNode(this.sfc);

      await this.sfc.rebaseTime();
      await this.sfc.enableNonNodeCalls();
      for (const account of [validator, secondValidator, thirdValidator, delegator, secondDelegator]) {
        await ethers.provider.send('hardhat_setBalance', [
          account.address,
          ethers.toBeHex(ethers.parseEther('10000000')),
        ]);
      }

      await blockchainNode.handleTx(
        await this.sfc.connect(validator).createValidator(pubkey, { value: ethers.parseEther('400000') }),
      );
      const validatorId = await this.sfc.getValidatorID(validator);
      await blockchainNode.handleTx(
        await this.sfc.connect(secondValidator).createValidator(secondPubkey, { value: ethers.parseEther('800000') }),
      );
      const secondValidatorId = await this.sfc.getValidatorID(secondValidator);
      await blockchainNode.handleTx(
        await this.sfc.connect(thirdValidator).createValidator(thirdPubkey, { value: ethers.parseEther('800000') }),
      );
      const thirdValidatorId = await this.sfc.getValidatorID(thirdValidator);

      await this.sfc.connect(validator).delegate(validatorId, { value: ethers.parseEther('400000') });
      await this.sfc.connect(delegator).delegate(validatorId, { value: ethers.parseEther('400000') });
      await this.sfc.connect(secondDelegator).delegate(secondValidatorId, { value: ethers.parseEther('400000') });

      await this.constants.updateValidatorCommission(ethers.parseEther('0.2'));
      await blockchainNode.sealEpoch(0);

      return {
        validator,
        pubkey,
        validatorId,
        secondValidator,
        secondPubkey,
        secondValidatorId,
        thirdValidator,
        thirdPubkey,
        thirdValidatorId,
        delegator,
        secondDelegator,
        blockchainNode,
      };
    };

    beforeEach(async function () {
      return Object.assign(this, await loadFixture(validatorsFixture.bind(this)));
    });

    it('Should succeed and return claimed Rewards until Epoch', async function () {
      await this.constants.updateBaseRewardPerSecond(1000);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      expect(await this.sfc.stashedRewardsUntilEpoch(this.delegator, this.validatorId)).to.equal(0);
      await this.sfc.connect(this.delegator).claimRewards(this.validatorId);
      expect(await this.sfc.stashedRewardsUntilEpoch(this.delegator, this.validatorId)).to.equal(
        await this.sfc.currentSealedEpoch(),
      );
    });

    it('Should succeed and check pending rewards of delegators', async function () {
      await this.constants.updateBaseRewardPerSecond(1000);
      expect(await this.sfc.pendingRewards(this.validator, this.validatorId)).to.equal(0);
      expect(await this.sfc.pendingRewards(this.delegator, this.validatorId)).to.equal(0);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      expect(await this.sfc.pendingRewards(this.validator, this.validatorId)).to.equal(23_280_000);
      expect(await this.sfc.pendingRewards(this.delegator, this.validatorId)).to.equal(8_400_000);
    });

    it('Should succeed and check if pending rewards have been increased after sealing epoch', async function () {
      await this.constants.updateBaseRewardPerSecond(1000);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      expect(await this.sfc.pendingRewards(this.validator, this.validatorId)).to.equal(23_280_000);
      expect(await this.sfc.pendingRewards(this.delegator, this.validatorId)).to.equal(8_400_000);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      expect(await this.sfc.pendingRewards(this.validator, this.validatorId)).to.equal(46_560_000);
      expect(await this.sfc.pendingRewards(this.delegator, this.validatorId)).to.equal(16_800_000);
    });

    it('Should succeed and increase balances after claiming rewards', async function () {
      await this.constants.updateBaseRewardPerSecond(100_000_000_000_000);
      await this.blockchainNode.sealEpoch(0);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      const delegatorPendingRewards = await this.sfc.pendingRewards(this.delegator, 1);
      expect(delegatorPendingRewards).to.equal(ethers.parseEther('0.864'));
      const delegatorBalance = await ethers.provider.getBalance(this.delegator.address);
      await this.sfc.connect(this.delegator).claimRewards(this.validatorId);
      const delegatorNewBalance = await ethers.provider.getBalance(this.delegator.address);
      expect(delegatorBalance + delegatorPendingRewards).to.be.above(delegatorNewBalance);
      expect(delegatorBalance + delegatorPendingRewards).to.be.below(delegatorNewBalance + ethers.parseEther('0.01'));
    });

    it('Should succeed and increase stake after restaking rewards', async function () {
      await this.constants.updateBaseRewardPerSecond(1000);
      await this.blockchainNode.sealEpoch(0);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);
      const delegatorPendingRewards = await this.sfc.pendingRewards(this.delegator, 1);
      expect(delegatorPendingRewards).to.equal(8_400_000);
      const delegatorStake = await this.sfc.getStake(this.delegator, this.validatorId);
      await this.sfc.connect(this.delegator).restakeRewards(this.validatorId);
      const delegatorNewStake = await this.sfc.getStake(this.delegator, this.validatorId);
      expect(delegatorNewStake).to.equal(delegatorStake + delegatorPendingRewards);
    });

    it('Should succeed and return stashed rewards', async function () {
      await this.constants.updateBaseRewardPerSecond(1000);

      await this.blockchainNode.sealEpoch(0);
      await this.blockchainNode.sealEpoch(60 * 60 * 24);

      expect(await this.sfc.rewardsStash(this.delegator, this.validatorId)).to.equal(0);

      await this.sfc.stashRewards(this.delegator, this.validatorId);
      expect(await this.sfc.rewardsStash(this.delegator, this.validatorId)).to.equal(8_400_000);
    });

    it('Should succeed and update the validator on node', async function () {
      await this.constants.updateOfflinePenaltyThresholdTime(86_400);
      await this.constants.updateOfflinePenaltyThresholdBlocksNum(500);

      expect(await this.constants.offlinePenaltyThresholdTime()).to.equal(86_400);
      expect(await this.constants.offlinePenaltyThresholdBlocksNum()).to.equal(500);
    });

    it('Should succeed and seal epochs', async function () {
      const validatorsMetrics: Map<bigint, ValidatorMetrics> = new Map();
      const validatorIDs = await this.sfc.lastValidatorID();

      for (let i = 1n; i <= validatorIDs; i++) {
        validatorsMetrics.set(i, {
          offlineTime: 0,
          offlineBlocks: 0,
          uptime: 24 * 60 * 60,
          originatedTxsFee: ethers.parseEther('100'),
        });
      }

      const allValidators = [];
      const offlineTimes = [];
      const offlineBlocks = [];
      const uptimes = [];
      const originatedTxsFees = [];
      for (let i = 1n; i <= validatorIDs; i++) {
        allValidators.push(i);
        offlineTimes.push(validatorsMetrics.get(i)!.offlineTime);
        offlineBlocks.push(validatorsMetrics.get(i)!.offlineBlocks);
        uptimes.push(validatorsMetrics.get(i)!.uptime);
        originatedTxsFees.push(validatorsMetrics.get(i)!.originatedTxsFee);
      }

      await this.sfc.advanceTime(24 * 60 * 60);
      await this.sfc.sealEpoch(offlineTimes, offlineBlocks, uptimes, originatedTxsFees);
      await this.sfc.sealEpochValidators(allValidators);
    });

    describe('Treasury', () => {
      it('Should revert when treasury is not set', async function () {
        await expect(this.sfc.resolveTreasuryFees()).to.be.revertedWithCustomError(this.sfc, 'TreasuryNotSet');
      });

      it('Should revert when no unresolved treasury fees are available', async function () {
        const treasury = ethers.Wallet.createRandom();
        await this.sfc.connect(this.owner).updateTreasuryAddress(treasury);
        await expect(this.sfc.resolveTreasuryFees()).to.be.revertedWithCustomError(
          this.sfc,
          'NoUnresolvedTreasuryFees',
        );
      });

      it('Should succeed and resolve treasury fees', async function () {
        // set treasury as failing receiver to trigger treasury fee accumulation
        const failingReceiver = await ethers.deployContract('FailingReceiver');
        await this.sfc.connect(this.owner).updateTreasuryAddress(failingReceiver);

        // set validators metrics and their fees
        const validatorsMetrics: Map<bigint, ValidatorMetrics> = new Map();
        const validatorIDs = await this.sfc.lastValidatorID();
        for (let i = 1n; i <= validatorIDs; i++) {
          validatorsMetrics.set(i, {
            offlineTime: 0,
            offlineBlocks: 0,
            uptime: 24 * 60 * 60,
            originatedTxsFee: ethers.parseEther('100'),
          });
        }

        // seal epoch to trigger fees calculation and distribution
        await this.blockchainNode.sealEpoch(24 * 60 * 60, validatorsMetrics);

        const fees =
          (validatorIDs * ethers.parseEther('100') * (await this.constants.treasuryFeeShare())) / BigInt(1e18);
        expect(await this.sfc.unresolvedTreasuryFees()).to.equal(fees);

        // update treasury to a valid receiver
        const treasury = ethers.Wallet.createRandom();
        await this.sfc.connect(this.owner).updateTreasuryAddress(treasury);

        // set sfc some balance to cover treasury fees
        // the funds cannot be sent directly as it rejects any incoming transfers
        await ethers.provider.send('hardhat_setBalance', [
          await this.sfc.getAddress(),
          ethers.toBeHex(ethers.parseEther('1000')),
        ]);

        // resolve treasury fees
        const tx = await this.sfc.resolveTreasuryFees();
        await expect(tx).to.emit(this.sfc, 'TreasuryFeesResolved').withArgs(fees);
        await expect(tx).to.changeEtherBalance(treasury, fees);
        await expect(tx).to.changeEtherBalance(this.sfc, -fees);
        expect(await this.sfc.unresolvedTreasuryFees()).to.equal(0);
      });
    });

    it('Should succeed and seal epoch on Validators', async function () {
      const validatorsMetrics: Map<bigint, ValidatorMetrics> = new Map();
      const validatorIDs = await this.sfc.lastValidatorID();

      for (let i = 1n; i <= validatorIDs; i++) {
        validatorsMetrics.set(i, {
          offlineTime: 0,
          offlineBlocks: 0,
          uptime: 24 * 60 * 60,
          originatedTxsFee: ethers.parseEther('0'),
        });
      }

      const allValidators = [];
      const offlineTimes = [];
      const offlineBlocks = [];
      const uptimes = [];
      const originatedTxsFees = [];
      for (let i = 1n; i <= validatorIDs; i++) {
        allValidators.push(i);
        offlineTimes.push(validatorsMetrics.get(i)!.offlineTime);
        offlineBlocks.push(validatorsMetrics.get(i)!.offlineBlocks);
        uptimes.push(validatorsMetrics.get(i)!.uptime);
        originatedTxsFees.push(validatorsMetrics.get(i)!.originatedTxsFee);
      }

      await this.sfc.advanceTime(24 * 60 * 60);
      await this.sfc.sealEpoch(offlineTimes, offlineBlocks, uptimes, originatedTxsFees);
      await this.sfc.sealEpochValidators(allValidators);
    });

    describe('Epoch getters', () => {
      it('Should succeed and return EpochvalidatorIds', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochValidatorIDs(currentSealedEpoch);
      });

      it('Should succeed and return the epoch received stake', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochReceivedStake(currentSealedEpoch, 1);
      });

      it('Should succeed and return the epoch accumulated reward per token', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochAccumulatedRewardPerToken(currentSealedEpoch, 1);
      });

      it('Should succeed and return the epoch accumulated uptime', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochAccumulatedUptime(currentSealedEpoch, 1);
      });

      it('Should succeed and return epoch accumulated originated txs fee', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochAccumulatedOriginatedTxsFee(currentSealedEpoch, 1);
      });

      it('Should succeed and return the epoch offline time', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochOfflineTime(currentSealedEpoch, 1);
      });

      it('Should succeed and return  epoch offline blocks', async function () {
        const currentSealedEpoch = await this.sfc.currentSealedEpoch();
        await this.sfc.getEpochOfflineBlocks(currentSealedEpoch, 1);
      });
    });

    describe('Epoch getters', () => {
      it('Should succeed and return slashed status', async function () {
        expect(await this.sfc.isSlashed(1)).to.equal(false);
      });

      it('Should revert when delegating to an unexisting validator', async function () {
        await expect(this.sfc.delegate(4)).to.be.revertedWithCustomError(this.sfc, 'ValidatorNotExists');
      });

      it('Should revert when delegating to an unexisting validator (2)', async function () {
        await expect(this.sfc.delegate(4, { value: ethers.parseEther('1') })).to.be.revertedWithCustomError(
          this.sfc,
          'ValidatorNotExists',
        );
      });
    });

    describe('SFC Rewards getters / Features', () => {
      it('Should succeed and return stashed rewards', async function () {
        expect(await this.sfc.rewardsStash(this.delegator, 1)).to.equal(0);
      });
    });

    it('Should succeed and setGenesisDelegation Validator', async function () {
      await this.sfc.setGenesisDelegation(this.delegator, this.validatorId, ethers.parseEther('1'));
      // delegator has already delegated 400000 in fixture
      expect(await this.sfc.getStake(this.delegator, this.validatorId)).to.equal(ethers.parseEther('400001'));
    });
  });

  describe('Rewarding', () => {
    // TODO name?
    const validatorsFixture = async function (this: Context) {
      const [validator, testValidator, firstDelegator, secondDelegator, thirdDelegator, account1, account2, account3] =
        await ethers.getSigners();
      const pubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc525f';
      const secondPubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc5251';
      const thirdPubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc5252';
      const blockchainNode = new BlockchainNode(this.sfc);

      await this.sfc.rebaseTime();
      await this.sfc.enableNonNodeCalls();
      await this.constants.updateBaseRewardPerSecond(ethers.parseEther('1'));

      for (const account of [account1, account2, account3]) {
        await ethers.provider.send('hardhat_setBalance', [
          account.address,
          ethers.toBeHex(ethers.parseEther('10000000')),
        ]);
      }
      await blockchainNode.handleTx(
        await this.sfc.connect(account1).createValidator(pubkey, { value: ethers.parseEther('1000000') }),
      );
      await blockchainNode.handleTx(
        await this.sfc.connect(account2).createValidator(secondPubkey, { value: ethers.parseEther('500000') }),
      );
      await blockchainNode.handleTx(
        await this.sfc.connect(account3).createValidator(thirdPubkey, { value: ethers.parseEther('100000') }),
      );

      const validatorId = await this.sfc.getValidatorID(account1);
      const secondValidatorId = await this.sfc.getValidatorID(account2);
      const thirdValidatorId = await this.sfc.getValidatorID(account3);

      return {
        validator,
        validatorId,
        testValidator,
        secondValidatorId,
        firstDelegator,
        thirdValidatorId,
        secondDelegator,
        thirdDelegator,
        blockchainNode,
        account1,
        account2,
        account3,
      };
    };

    beforeEach(async function () {
      return Object.assign(this, await loadFixture(validatorsFixture.bind(this)));
    });

    describe('Rewards calculation', () => {
      it('Should distribute duration*baseRewardPerSecond for validators', async function () {
        await this.constants.updateBaseRewardPerSecond(ethers.parseEther('2'));
        await this.blockchainNode.sealEpoch(0); // apply validators changes
        await this.blockchainNode.sealEpoch(123);

        const reward1 = await this.sfc.pendingRewards(this.account1, this.validatorId);
        const reward2 = await this.sfc.pendingRewards(this.account2, this.secondValidatorId);
        const reward3 = await this.sfc.pendingRewards(this.account3, this.thirdValidatorId);

        expect(reward1).to.not.equal(0);
        expect(reward2).to.not.equal(0);
        expect(reward3).to.not.equal(0);
        expect(reward1 + reward2 + reward3).to.equal(ethers.parseEther('2') * 123n);

        await expect(this.sfc.connect(this.account1).claimRewards(this.validatorId)).to.changeEtherBalance(
          this.account1,
          reward1,
        );
        await expect(this.sfc.connect(this.account2).claimRewards(this.secondValidatorId)).to.changeEtherBalance(
          this.account2,
          reward2,
        );
        await expect(this.sfc.connect(this.account3).claimRewards(this.thirdValidatorId)).to.changeEtherBalance(
          this.account3,
          reward3,
        );
      });

      it('Should distribute duration*baseRewardPerSecond for validators and delegators', async function () {
        await this.constants.updateBaseRewardPerSecond(ethers.parseEther('2'));
        await this.sfc
          .connect(this.firstDelegator)
          .delegate(this.secondValidatorId, { value: ethers.parseEther('1000') });
        await this.blockchainNode.sealEpoch(0); // apply validators changes
        await this.blockchainNode.sealEpoch(123);

        const reward1 = await this.sfc.pendingRewards(this.account1, this.validatorId);
        const reward2 = await this.sfc.pendingRewards(this.account2, this.secondValidatorId);
        const reward3 = await this.sfc.pendingRewards(this.account3, this.thirdValidatorId);
        const reward4 = await this.sfc.pendingRewards(this.firstDelegator, this.secondValidatorId);

        expect(reward1).to.not.equal(0);
        expect(reward2).to.not.equal(0);
        expect(reward3).to.not.equal(0);
        expect(reward4).to.not.equal(0);
        expect(reward1 + reward2 + reward3 + reward4).to.be.lessThanOrEqual(ethers.parseEther('2') * 123n);

        await expect(this.sfc.connect(this.account1).claimRewards(this.validatorId)).to.changeEtherBalance(
          this.account1,
          reward1,
        );
        await expect(this.sfc.connect(this.firstDelegator).claimRewards(this.secondValidatorId)).to.changeEtherBalance(
          this.firstDelegator,
          reward4,
        );
      });

      it('Rejects to claim when no rewards yet', async function () {
        await this.blockchainNode.sealEpoch(1_000);
        await this.sfc.connect(this.thirdDelegator).delegate(this.thirdValidatorId, { value: ethers.parseEther('10') });
        await this.blockchainNode.sealEpoch(1_000);
        expect(await this.sfc.pendingRewards(this.thirdDelegator, this.validatorId)).to.equal(0);
        await expect(
          this.sfc.connect(this.thirdDelegator).claimRewards(this.validatorId),
        ).to.be.revertedWithCustomError(this.sfc, 'ZeroRewards');
      });
    });

    describe('Undelegation', () => {
      // TODO test successful undelegation

      it('Rejects to withdraw when request does not exists', async function () {
        await expect(this.sfc.withdraw(this.validatorId, 0)).to.be.revertedWithCustomError(
          this.sfc,
          'RequestNotExists',
        );
      });

      it('Rejects to undelegate 0 amount', async function () {
        await this.blockchainNode.sealEpoch(1_000);
        await expect(this.sfc.undelegate(this.validatorId, 0, 0)).to.be.revertedWithCustomError(this.sfc, 'ZeroAmount');
      });
    });

    it('Rejects to set refund ration for non-slashed validator', async function () {
      await this.blockchainNode.sealEpoch(1_000);
      await expect(this.sfc.connect(this.validator).updateSlashingRefundRatio(1, 1)).to.be.revertedWithCustomError(
        this.sfc,
        'ValidatorNotSlashed',
      );
    });

    it('Rejects syncing non-existing validator', async function () {
      await expect(this.sfc.syncValidator(33, false)).to.be.revertedWithCustomError(this.sfc, 'ValidatorNotExists');
    });
  });

  describe('Average uptime calculation', () => {
    const validatorsFixture = async function (this: Context) {
      const [validator] = await ethers.getSigners();
      const pubkey =
        '0xc000a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc525f';
      const blockchainNode = new BlockchainNode(this.sfc);

      await this.sfc.rebaseTime();
      await this.sfc.enableNonNodeCalls();
      await ethers.provider.send('hardhat_setBalance', [
        validator.address,
        ethers.toBeHex(ethers.parseEther('10000000')),
      ]);

      await this.constants.updateAverageUptimeEpochWindow(10);

      await blockchainNode.handleTx(
        await this.sfc.connect(validator).createValidator(pubkey, { value: ethers.parseEther('100000') }),
      );

      const validatorId = await this.sfc.getValidatorID(validator);

      await blockchainNode.sealEpoch(0);

      return {
        validatorId,
        blockchainNode,
      };
    };

    beforeEach(async function () {
      return Object.assign(this, await loadFixture(validatorsFixture.bind(this)));
    });

    it('Should calculate uptime correctly', async function () {
      // validator online 100% of time in the first epoch => average 100%
      await this.blockchainNode.sealEpoch(
        100,
        new Map<bigint, ValidatorMetrics>([[this.validatorId, new ValidatorMetrics(0, 0, 100, 0n)]]),
      );
      expect(await this.sfc.getEpochAverageUptime(await this.sfc.currentSealedEpoch(), this.validatorId)).to.equal(
        1000000000000000000n,
      );

      // validator online 20% of time in the second epoch => average 60%
      await this.blockchainNode.sealEpoch(
        100,
        new Map<bigint, ValidatorMetrics>([[this.validatorId, new ValidatorMetrics(0, 0, 20, 0n)]]),
      );
      expect(await this.sfc.getEpochAverageUptime(await this.sfc.currentSealedEpoch(), this.validatorId)).to.equal(
        600000000000000000n,
      );

      // validator online 30% of time in the third epoch => average 50%
      await this.blockchainNode.sealEpoch(
        100,
        new Map<bigint, ValidatorMetrics>([[this.validatorId, new ValidatorMetrics(0, 0, 30, 0n)]]),
      );
      expect(await this.sfc.getEpochAverageUptime(await this.sfc.currentSealedEpoch(), this.validatorId)).to.equal(
        500000000000000000n,
      );

      // fill the averaging window
      for (let i = 0; i < 10; i++) {
        await this.blockchainNode.sealEpoch(
          100,
          new Map<bigint, ValidatorMetrics>([[this.validatorId, new ValidatorMetrics(0, 0, 50, 0n)]]),
        );
        expect(await this.sfc.getEpochAverageUptime(await this.sfc.currentSealedEpoch(), this.validatorId)).to.equal(
          500000000000000000n,
        );
      }

      // (50 * 10 + 28) / 11 = 48
      await this.blockchainNode.sealEpoch(
        100,
        new Map<bigint, ValidatorMetrics>([[this.validatorId, new ValidatorMetrics(0, 0, 28, 0n)]]),
      );
      expect(await this.sfc.getEpochAverageUptime(await this.sfc.currentSealedEpoch(), this.validatorId)).to.equal(
        480000000000000000n,
      );
    });
  });

  describe('Extra rewards distribution', () => {
    const validatorsFixture = async function (this: Context) {
      const blockchainNode = new BlockchainNode(this.sfc);
      await this.sfc.rebaseTime();
      await this.sfc.enableNonNodeCalls();

      const signers = await ethers.getSigners();
      for (let i = 1; i <= 10; i++) {
        const pubKey = ethers.concat(['0xc0', ethers.Wallet.createRandom().signingKey.publicKey]);
        const stake = Math.floor(Math.random() * 50000) + 100000;

        await ethers.provider.send('hardhat_setBalance', [
          signers[i].address,
          ethers.toBeHex(ethers.parseEther((stake + 10000).toString())),
        ]);

        await blockchainNode.handleTx(
          await this.sfc.connect(signers[i]).createValidator(pubKey, { value: ethers.parseEther(stake.toString()) }),
        );
      }
      await blockchainNode.sealEpoch(0); // empty genesis epoch
      await blockchainNode.sealEpoch(0); // sealed with the vals above

      return {
        blockchainNode,
      };
    };

    beforeEach(async function () {
      return Object.assign(this, await loadFixture(validatorsFixture.bind(this)));
    });

    it('Should reject extra rewards for unsealed epoch', async function () {
      expect(await this.sfc.currentSealedEpoch()).to.equal(2);
      await expect(this.sfc.distributeExtraReward(3, false)).to.be.revertedWithCustomError(this.sfc, 'InvalidEpoch');
    });

    it('Should reject zero amount of extra rewards', async function () {
      await expect(this.sfc.distributeExtraReward(2, false, { value: 0 })).to.be.revertedWithCustomError(
        this.sfc,
        'ZeroRewards',
      );
    });

    const tryToDistributeRewards = async function (this: Context, epoch: number, withBurn: boolean) {
      expect(await this.sfc.currentSealedEpoch()).to.greaterThanOrEqual(epoch);

      // check the initial rewards stash state is clean
      const valsID = await this.sfc.getEpochValidatorIDs(epoch);
      const signers = await ethers.getSigners();
      for (let i = 0; i < valsID.length; i++) {
        expect(await this.sfc.rewardsStash(signers[i + 1].address, valsID[i])).to.equal(0);
      }

      const amount = ethers.parseEther((Math.floor(Math.random() * 10) + 1).toString());
      let expectedToDistribute = amount;
      if (withBurn) {
        expectedToDistribute =
          (amount * (BigInt(1e18) - (await this.constants.extraRewardsBurnRatio()))) / BigInt(1e18);
      }

      const tx = await this.sfc.distributeExtraReward(epoch, withBurn, { value: amount });
      await expect(tx).to.emit(this.sfc, 'DistributedExtraRewards');

      const result = await tx.wait();
      const reportedDistributed = result.logs?.find(
        (e: { fragment: { name: string } }) => e.fragment?.name === 'DistributedExtraRewards',
      )?.args?.[2];

      // the burn caused by the int math rounding should be at most 1wei per validator
      expect(reportedDistributed).to.lessThanOrEqual(expectedToDistribute);
      expect(reportedDistributed).to.approximately(expectedToDistribute, valsID.length, 'Inherent burn too large');

      // verify the number of stashed rewards on each validator is correct
      for (let i = 0; i < valsID.length; i++) {
        const expectedStashedReward =
          (expectedToDistribute * this.blockchainNode.validatorWeights.get(valsID[i])) /
          this.blockchainNode.totalWeight;
        expect(await this.sfc.rewardsStash(signers[i + 1].address, valsID[i])).to.equal(expectedStashedReward);
      }
    };

    it('Should distribute extra rewards without burn', async function () {
      await tryToDistributeRewards.bind(this)(2, false);
    });

    it('Should distribute extra rewards with zero burn ratio', async function () {
      await this.constants.updateExtraRewardsBurnRatio(0);
      await tryToDistributeRewards.bind(this)(2, true);
    });

    it('Should distribute extra rewards with pre-configured burn ratio', async function () {
      const ratio = BigInt(Math.floor(Math.random() * 75) + 15);
      await this.constants.updateExtraRewardsBurnRatio((ratio * BigInt(1e18)) / 100n);

      await tryToDistributeRewards.bind(this)(2, true);
    });
  });
});
