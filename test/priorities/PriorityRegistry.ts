import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';

describe('PriorityRegistry', () => {
  const fixture = async () => {
    const [owner, priorityManager, configurator, pauser, user] = await ethers.getSigners();

    // Deploy a stub SFC contract to copy code from and set at the SFC address
    const stubSfc = await ethers.deployContract('StubSFC', [owner]);
    await ethers.provider.send('hardhat_setCode', [
      '0xFC00FACE00000000000000000000000000000000',
      await stubSfc.getDeployedCode(),
    ]);

    const erc20 = await ethers.deployContract('TestingERC20', []);

    const registry = await upgrades.deployProxy(await ethers.getContractFactory('PriorityRegistry'), [], {
      kind: 'uups',
    });

    // Impersonate the Sonic node (address(0)) for testing purposes and fund it
    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await user.sendTransaction({
      to: await node.getAddress(),
      value: ethers.parseEther('10'),
    });

    const PRIORITY_MANAGER_ROLE = await registry.PRIORITY_MANAGER_ROLE();
    await registry.connect(owner).grantRole(PRIORITY_MANAGER_ROLE, await priorityManager.getAddress());

    const CONFIGURATOR_ROLE = await registry.CONFIGURATOR_ROLE();
    await registry.connect(owner).grantRole(CONFIGURATOR_ROLE, await configurator.getAddress());

    const PAUSER_ROLE = await registry.PAUSER_ROLE();
    await registry.connect(owner).grantRole(PAUSER_ROLE, await pauser.getAddress());

    return {
      owner,
      priorityManager,
      configurator,
      pauser,
      user,
      registry,
      node,
      erc20,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Grants DEFAULT_ADMIN_ROLE to the SFC owner', async function () {
    const DEFAULT_ADMIN_ROLE = await this.registry.DEFAULT_ADMIN_ROLE();
    expect(await this.registry.hasRole(DEFAULT_ADMIN_ROLE, await this.owner.getAddress())).to.equal(true);
  });

  describe('getPriority', async function () {
    beforeEach(async function () {
      this.level = 5n;
      this.weight = 42n;
      this.entityId = ethers.zeroPadValue('0x01', 32);
      await this.registry
        .connect(this.priorityManager)
        .setSenderPriority(await this.user.getAddress(), this.level, this.weight, this.entityId);

      const transferInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
      this.callData = transferInterface.encodeFunctionData('transfer', [await this.owner.getAddress(), 100]);
    });

    it('Returns no priority for a sender without priority', async function () {
      const [gotLevel, gotWeight, gotId] = await this.registry.getPriority(
        await this.owner.getAddress(),
        await this.erc20.getAddress(),
        0, // value
        0, // nonce
        this.callData,
        21000,
      );
      expect(gotLevel).to.equal(0);
      expect(gotWeight).to.equal(0);
      expect(gotId).to.equal(ethers.ZeroHash);
    });

    it('Provides priority as configured', async function () {
      const [gotLevel, gotWeight, gotId] = await this.registry.getPriority(
        await this.user.getAddress(),
        await this.erc20.getAddress(),
        0, // value
        7, // nonce
        this.callData,
        21000,
      );
      expect(gotLevel).to.equal(this.level);
      expect(gotWeight).to.equal(this.weight);
      expect(gotId).to.equal(this.entityId);
    });

    it('Rejects txs exceeding maxGasPerTx', async function () {
      await this.registry.connect(this.configurator).setMaxGasPerTx(20000);

      const [gotLevel, gotWeight] = await this.registry.getPriority(
        await this.user.getAddress(),
        await this.erc20.getAddress(),
        0, // value
        7, // nonce
        this.callData,
        21000,
      );
      expect(gotLevel).to.equal(0);
      expect(gotWeight).to.equal(0);
    });

    it('Rejects txs when paused', async function () {
      await this.registry.connect(this.pauser).pause();

      const transferInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
      const calldata = transferInterface.encodeFunctionData('transfer', [await this.owner.getAddress(), 100]);
      let [gotLevel, gotWeight] = await this.registry.getPriority(
        await this.user.getAddress(),
        await this.erc20.getAddress(),
        0, // value
        7, // nonce
        calldata,
        21000,
      );
      expect(gotLevel).to.equal(0);
      expect(gotWeight).to.equal(0);

      await this.registry.connect(this.pauser).unpause();

      [gotLevel, gotWeight] = await this.registry.getPriority(
        await this.user.getAddress(),
        await this.erc20.getAddress(),
        0, // value
        8, // nonce
        calldata,
        21000,
      );
      expect(gotLevel).to.equal(this.level);
      expect(gotWeight).to.equal(this.weight);
    });
  });

  describe('getPriorityConfig', async function () {
    it('Returns default values when not set', async function () {
      const [maxGasPerEntityPerBlock, maxPiggybackTxsPerEntityPerEvent] = await this.registry.getPriorityConfig();
      expect(maxGasPerEntityPerBlock).to.equal(await this.registry.DEFAULT_MAX_GAS_PER_BLOCK());
      expect(maxPiggybackTxsPerEntityPerEvent).to.equal(await this.registry.DEFAULT_MAX_PIGGYBACK_PER_EVENT());
    });

    it('Returns configured values', async function () {
      await this.registry.connect(this.configurator).setMaxGasPerEntityPerBlock(123456);
      await this.registry.connect(this.configurator).setMaxPiggybackTxsPerEntityPerEvent(7);

      const [maxGasPerEntityPerBlock, maxPiggybackTxsPerEntityPerEvent] = await this.registry.getPriorityConfig();
      expect(maxGasPerEntityPerBlock).to.equal(123456);
      expect(maxPiggybackTxsPerEntityPerEvent).to.equal(7);
    });
  });

  it('Prevents calling restricted method from unauthorized accounts', async function () {
    await expect(this.registry.connect(this.user).pause()).to.be.revertedWithCustomError(
      this.registry,
      'AccessControlUnauthorizedAccount',
    );
    await expect(this.registry.connect(this.user).unpause()).to.be.revertedWithCustomError(
      this.registry,
      'AccessControlUnauthorizedAccount',
    );
    await expect(
      this.registry.connect(this.user).setSenderPriority(await this.user.getAddress(), 1, 1, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(this.registry, 'AccessControlUnauthorizedAccount');
    await expect(
      this.registry.connect(this.user).setMaxGasPerTx(1),
    ).to.be.revertedWithCustomError(this.registry, 'AccessControlUnauthorizedAccount');
    await expect(
      this.registry.connect(this.user).upgradeToAndCall(await this.registry.getAddress(), '0x'),
    ).to.be.revertedWithCustomError(this.registry, 'AccessControlUnauthorizedAccount');
  });

  it('Prevents calling restricted method after role revocation', async function () {
    const PRIORITY_MANAGER_ROLE = await this.registry.PRIORITY_MANAGER_ROLE();
    await this.registry.connect(this.owner).revokeRole(PRIORITY_MANAGER_ROLE, await this.priorityManager.getAddress());

    await expect(
      this.registry
        .connect(this.priorityManager)
        .setSenderPriority(await this.user.getAddress(), 1, 1, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(this.registry, 'AccessControlUnauthorizedAccount');
  });

});
