import { ethers, upgrades } from 'hardhat';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { IEVMWriter, NetworkInitializer } from '../typechain-types';

describe('NodeDriver', () => {
  const frozenAccountImpl = '0xCdC13932990fDBC8e4397AF1BFd0762D7E6d71bA';
  const frozenAccountImplCode =
    '0x608060405236603a576040517fed40684000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6040517fed40684000000000000000000000000000000000000000000000000000000000815260040160405180910390fdfea26469706673582212206cf1a51a4e5cb0532b7b5e5e0cb6f65f8e2edc1f1d1fe43ee664113b62dddf7664736f6c634300081e0033';

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

    // deploy frozen account impl
    await ethers.provider.send('hardhat_setCode', [frozenAccountImpl, frozenAccountImplCode]);

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

  describe('Freeze account', () => {
    it('Should freeze an external account', async function () {
      await expect(this.nodeDriverAuth.freezeAccount('0xFa00AE0000000000000000000000000000000000', 'testing freeze'))
        .to.emit(this.nodeDriverAuth, 'FrozenAccount')
        .withArgs('0xFa00AE0000000000000000000000000000000000', 'testing freeze');
    });

    it('Should freeze an account with EIP-7702 delegation', async function () {
      const [userWithDelegation] = await ethers.getSigners();
      await ethers.provider.send('hardhat_setCode', [
        userWithDelegation.address,
        '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b', // EIP-7702 delegation to 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B
      ]);
      await expect(this.nodeDriverAuth.freezeAccount(userWithDelegation, 'testing freeze'))
        .to.emit(this.nodeDriverAuth, 'FrozenAccount')
        .withArgs(userWithDelegation.address, 'testing freeze');
    });

    it('Should reject to freeze a contract', async function () {
      await expect(this.nodeDriverAuth.freezeAccount(this.sfc, 'testing freeze')).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'NotExternalAccount',
      );
    });

    it('Should revert when not owner', async function () {
      await expect(
        this.nodeDriverAuth
          .connect(this.nonOwner)
          .freezeAccount('0xFa00AE0000000000000000000000000000000000', 'testing freeze'),
      ).to.be.revertedWithCustomError(this.nodeDriverAuth, 'OwnableUnauthorizedAccount');
    });
  });

  describe('Unfreeze account', () => {
    it('Should unfreeze an account', async function () {
      const account = '0xFa00AE0000000000000000000000000000000000';
      await ethers.provider.send('hardhat_setCode', [account, frozenAccountImplCode]);
      await expect(
        this.nodeDriverAuth.unfreezeAccount('0xFa00AE0000000000000000000000000000000000', 'testing unfreeze'),
      )
        .to.emit(this.nodeDriverAuth, 'UnfrozenAccount')
        .withArgs('0xFa00AE0000000000000000000000000000000000', 'testing unfreeze');
    });

    it('Should reject to overwrite a contract', async function () {
      await expect(this.nodeDriverAuth.unfreezeAccount(this.sfc, 'testing freeze')).to.be.revertedWithCustomError(
        this.nodeDriverAuth,
        'NotFrozenAccount',
      );
    });

    it('Should reject to overwrite a not-frozen account', async function () {
      await expect(
        this.nodeDriverAuth.unfreezeAccount('0xFa00AE0000000000000000000000000000000000', 'testing freeze'),
      ).to.be.revertedWithCustomError(this.nodeDriverAuth, 'NotFrozenAccount');
    });

    it('Should revert when not owner', async function () {
      await expect(
        this.nodeDriverAuth
          .connect(this.nonOwner)
          .unfreezeAccount('0xFa00AE0000000000000000000000000000000000', 'testing freeze'),
      ).to.be.revertedWithCustomError(this.nodeDriverAuth, 'OwnableUnauthorizedAccount');
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
