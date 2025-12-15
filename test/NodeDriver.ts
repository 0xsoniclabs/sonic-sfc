import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { IEVMWriter, NetworkInitializer } from '../typechain-types';

describe('NodeDriver', () => {
  const fixture = async () => {
    const [owner, nonOwner] = await ethers.getSigners();
    const sfc = await upgrades.deployProxy(await ethers.getContractFactory('SFC'), {
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

    const initializer: NetworkInitializer = await ethers.deployContract('NetworkInitializer');
    const evmWriter: IEVMWriter = await ethers.deployContract('StubEvmWriter');

    // Impersonate the Sonic node (address(0)) for testing purposes and fund it
    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await nonOwner.sendTransaction({
      to: await node.getAddress(),
      value: ethers.parseEther('10'),
    });

    await initializer.connect(node).initializeAll(12, 0, sfc, nodeDriverAuth, nodeDriver, evmWriter, owner);

    return {
      owner,
      nonOwner,
      node,
      sfc,
      nodeDriver,
      evmWriter,
      nodeDriverAuth,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  describe('Update network version', () => {
    it('Should succeed and update network version', async function () {
      await expect(this.nodeDriverAuth.connect(this.owner).updateNetworkVersion(1))
        .to.emit(this.nodeDriver, 'UpdateNetworkVersion')
        .withArgs(1);
    });

    it('Should revert when not owner', async function () {
      await expect(this.nodeDriverAuth.connect(this.nonOwner).updateNetworkVersion(1)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('Update network rules', () => {
    it('Should succeed and update network rules', async function () {
      const diff = ethers.toUtf8Bytes('{"key":"value"}');
      await expect(this.nodeDriverAuth.connect(this.owner).updateNetworkRules(diff))
        .to.emit(this.nodeDriver, 'UpdateNetworkRules')
        .withArgs(diff);
    });

    it('Should revert when not owner', async function () {
      const diff = ethers.toUtf8Bytes('{"key":"value"}');
      await expect(this.nodeDriverAuth.connect(this.nonOwner).updateNetworkRules(diff)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'OwnableUnauthorizedAccount',
      );
    });

    it('Should revert when not backend', async function () {
      const diff = ethers.toUtf8Bytes('{"key":"value"}');
      await expect(this.nodeDriver.connect(this.nonOwner).updateNetworkRules(diff)).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotBackend',
      );
    });
  });

  describe('Advance epoch', () => {
    it('Should succeed and advance epoch', async function () {
      await expect(this.nodeDriverAuth.advanceEpochs(10)).to.emit(this.nodeDriver, 'AdvanceEpochs').withArgs(10);
    });

    it('Should revert when not owner', async function () {
      await expect(this.nodeDriverAuth.connect(this.nonOwner).advanceEpochs(10)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'OwnableUnauthorizedAccount',
      );
    });

    it('Should revert when not backend', async function () {
      await expect(this.nodeDriver.connect(this.nonOwner).advanceEpochs(10)).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotBackend',
      );
    });
  });

  describe('Add genesis validator and delegation', () => {
    it('Should succeed', async function () {
      const account = ethers.Wallet.createRandom();
      await this.nodeDriver.connect(this.node).setGenesisValidator(account, 1, account.publicKey, Date.now());
      await expect(this.nodeDriver.connect(this.node).setGenesisDelegation(account, 1, 100))
        .to.emit(this.nodeDriver, 'UpdateValidatorPubkey')
        .withArgs(1, account.publicKey)
        .to.emit(this.nodeDriver, 'UpdateValidatorWeight')
        .withArgs(1, 100);
    });

    it('Should revert when not node', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(
        this.nodeDriver.setGenesisValidator(account, 1, account.publicKey, Date.now()),
      ).to.be.revertedWithCustomError(this.nodeDriver, 'NotNode');
      await expect(this.nodeDriver.setGenesisDelegation(account, 1, 100)).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotNode',
      );
    });

    it('Should revert when not NodeDriver', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(
        this.nodeDriverAuth.setGenesisValidator(account, 1, account.publicKey, Date.now()),
      ).to.be.revertedWithCustomError(this.nodeDriverAuth, 'NotDriver');
      await expect(this.nodeDriverAuth.setGenesisDelegation(account, 1, 100)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'NotDriver',
      );
    });
  });

  describe('Deactivate validator', () => {
    it('Should succeed for existing validator', async function () {
      const account = ethers.Wallet.createRandom();
      await this.nodeDriver.connect(this.node).setGenesisValidator(account, 1, account.publicKey, Date.now());
      await expect(this.nodeDriver.connect(this.node).deactivateValidator(1, 1))
        .to.emit(this.nodeDriver, 'UpdateValidatorWeight')
        .withArgs(1, 0);
    });

    it('Should reject to activate', async function () {
      const account = ethers.Wallet.createRandom();
      await this.nodeDriver.connect(this.node).setGenesisValidator(account, 1, account.publicKey, Date.now());
      const OK_STATUS = 0;
      await expect(this.nodeDriver.connect(this.node).deactivateValidator(1, OK_STATUS)).to.be.revertedWithCustomError(
        this.sfc,
        'NotDeactivatedStatus',
      );
    });

    it('Should revert when not node', async function () {
      await expect(this.nodeDriver.deactivateValidator(1, 1)).to.be.revertedWithCustomError(this.nodeDriver, 'NotNode');
    });

    it('Should revert when not NodeDriver', async function () {
      await expect(this.nodeDriverAuth.deactivateValidator(1, 1)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'NotDriver',
      );
    });
  });

  describe('Seal epoch validators', () => {
    it('Should succeed', async function () {
      await this.nodeDriver.connect(this.node).sealEpochValidators([0, 1]);
    });

    it('Should revert when not node', async function () {
      await expect(this.nodeDriver.sealEpochValidators([0, 1])).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotNode',
      );
    });

    it('Should revert when not NodeDriver', async function () {
      await expect(this.nodeDriverAuth.sealEpochValidators([0, 1])).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'NotDriver',
      );
    });
  });

  describe('Seal epoch', () => {
    it('Should succeed', async function () {
      await this.nodeDriver.connect(this.node).sealEpoch([0, 1], [0, 1], [0, 1], [0, 1]);
    });

    it('Should revert when not node', async function () {
      await expect(this.nodeDriver.sealEpoch([0, 1], [0, 1], [0, 1], [0, 1])).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotNode',
      );
    });

    it('Should revert when not NodeDriver', async function () {
      await expect(
        this.nodeDriverAuth.connect(this.nonOwner).sealEpoch([0, 1], [0, 1], [0, 1], [0, 1]),
      ).to.be.revertedWithCustomError(this.nodeDriverAuth, 'NotDriver');
    });
  });

  describe('Increment account nonce', () => {
    it('Should succeed', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(this.nodeDriverAuth.connect(this.owner).incNonce(account, 5))
        .to.emit(this.evmWriter, 'EvmWriterIncNonce')
        .withArgs(account, 5);
    });

    it('Should revert when not owner', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(this.nodeDriverAuth.connect(this.nonOwner).incNonce(account, 5)).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'OwnableUnauthorizedAccount',
      );
    });

    it('Should revert when not NodeDriverAuth', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(this.nodeDriver.connect(this.nonOwner).incNonce(account, 5)).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotBackend',
      );
    });
  });
});
