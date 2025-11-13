import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { IEVMWriter, NetworkInitializer } from '../typechain-types';

describe('NodeDriver', () => {
  const fixture = async () => {
    const [owner, nonOwner] = await ethers.getSigners();
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
      await expect(this.nodeDriverAuth.updateNetworkVersion(1))
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
  });

  describe('Add genesis validator', () => {
    it('Should succeed', async function () {
      const account = ethers.Wallet.createRandom();
      await this.nodeDriver.connect(this.node).setGenesisValidator(account, 1, account.publicKey, Date.now());
    });

    it('Should revert when not node', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(
        this.nodeDriver.setGenesisValidator(account, 1, account.publicKey, Date.now()),
      ).to.be.revertedWithCustomError(this.nodeDriver, 'NotNode');
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
  });

  describe('Set genesis delegation', () => {
    it('Should succeed', async function () {
      const account = ethers.Wallet.createRandom();
      await this.nodeDriver.connect(this.node).setGenesisValidator(account, 1, account.publicKey, Date.now());
      await expect(this.nodeDriver.connect(this.node).setGenesisDelegation(account, 1, 100))
        .to.emit(this.nodeDriver, 'UpdateValidatorWeight')
        .withArgs(1, 100);
    });

    it('Should revert when not node', async function () {
      const account = ethers.Wallet.createRandom();
      await expect(this.nodeDriver.setGenesisDelegation(account, 1, 100)).to.be.revertedWithCustomError(
        this.nodeDriver,
        'NotNode',
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
  });
});
