import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { deploySubsidiesRegistryAtFixedAddress } from './helpers/SubsidiesRegistryFixture';

const SUBSIDY_MODE_NONE = 0n;
const SUBSIDY_MODE_TRACKED = 3n;
const noFundId = '0x0000000000000000000000000000000000000000000000000000000000000000';

const TOKEN_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TOKEN_MANAGER_ROLE'));

describe('TokenTransferSubsidies', () => {
  const fixture = async () => {
    const [admin, tokenManager, stranger] = await ethers.getSigners();

    // StubSFC uses immutable owner, so the value is embedded in bytecode after hardhat_setCode
    const stubSfc = await ethers.deployContract('StubSFC', [admin.address]);
    await ethers.provider.send('hardhat_setCode', [
      '0xFC00FACE00000000000000000000000000000000',
      await stubSfc.getDeployedCode(),
    ]);

    const registry = await deploySubsidiesRegistryAtFixedAddress();

    // initialize() reads owner from SubsidiesRegistry, so SubsidiesRegistry must be deployed first
    const extension = await upgrades.deployProxy(await ethers.getContractFactory('TokenTransferSubsidies'), [], {
      kind: 'uups',
    });

    await registry.connect(admin).addExtension(await extension.getAddress());
    await extension.connect(admin).grantRole(TOKEN_MANAGER_ROLE, tokenManager.address);

    const erc20 = await ethers.deployContract('TestingERC20', []);
    const dailyLimit = 10;
    await extension.connect(tokenManager).registerToken(await erc20.getAddress(), dailyLimit);

    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await admin.sendTransaction({ to: await node.getAddress(), value: ethers.parseEther('10') });

    const transferInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const makeTransferCalldata = (to: string) => transferInterface.encodeFunctionData('transfer', [to, 10_000]);

    return {
      admin,
      tokenManager,
      stranger,
      registry,
      extension,
      erc20,
      node,
      makeTransferCalldata,
      dailyLimit,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Reports its tracking ID prefix', async function () {
    expect(await this.extension.trackingIdPrefix()).to.equal(0xf7);
  });

  it('Allows free transfer via SubsidiesRegistry', async function () {
    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();
    const calldata = this.makeTransferCalldata(to.address);
    const fee = 543;
    const erc20Address = await this.erc20.getAddress();

    expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(this.dailyLimit);

    const [mode, trackingId] = await this.registry
      .connect(this.node)
      .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
    expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
    expect(trackingId).to.not.equal(noFundId);
    expect(BigInt(trackingId) >> 248n).to.equal(0xf7n);

    await this.registry.connect(this.node).track(trackingId, fee);
    expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(this.dailyLimit - 1);
  });

  it('Enforces leaking bucket', async function () {
    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();
    const calldata = this.makeTransferCalldata(to.address);
    const fee = 100;

    for (let i = 0; i < this.dailyLimit; i++) {
      const [mode, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
      expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
      await this.registry.connect(this.node).track(trackingId, fee);
    }

    const [modeExhausted] = await this.registry
      .connect(this.node)
      .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
    expect(modeExhausted).to.equal(SUBSIDY_MODE_NONE);

    // Advance half a day — bucket refills by floor(10 / 2) = 5
    await time.increase(12 * 60 * 60);

    const halfLimit = Math.floor(this.dailyLimit / 2);
    for (let i = 0; i < halfLimit; i++) {
      const [mode, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
      expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
      await this.registry.connect(this.node).track(trackingId, fee);
    }

    const [modeHalfExhausted] = await this.registry
      .connect(this.node)
      .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
    expect(modeHalfExhausted).to.equal(SUBSIDY_MODE_NONE);
  });

  it('Rejects transfer of non-registered token', async function () {
    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();
    const otherToken = await ethers.deployContract('TestingERC20', []);

    const [mode] = await this.registry.chooseFund(
      from.address,
      otherToken,
      0,
      1,
      this.makeTransferCalldata(to.address),
      100,
    );
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  it('Rejects approve call data', async function () {
    const from = ethers.Wallet.createRandom();
    const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
    const calldata = approveInterface.encodeFunctionData('approve', [from.address, 1_000]);

    const [mode] = await this.registry.chooseFund(from.address, this.erc20, 0, 1, calldata, 100);
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  it('Rejects track call not from SubsidiesRegistry', async function () {
    const erc20Address = await this.erc20.getAddress();
    const trackingId = ethers.zeroPadValue(ethers.toBeHex((0xf7n << 248n) | BigInt(erc20Address)), 32);

    await expect(this.extension.connect(this.admin).track(trackingId, 100)).to.be.revertedWithCustomError(
      this.extension,
      'NotSubsidiesRegistry',
    );
  });

  it('Changing limit resets bucket to full', async function () {
    const erc20Address = await this.erc20.getAddress();
    const newLimit = 20;
    await this.extension.connect(this.tokenManager).setFreeTransfersDailyLimit(erc20Address, newLimit);
    expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(newLimit);
  });

  it('Setting limit to 0 stops sponsorship', async function () {
    const erc20Address = await this.erc20.getAddress();
    await this.extension.connect(this.tokenManager).setFreeTransfersDailyLimit(erc20Address, 0);

    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();

    const [mode] = await this.registry.chooseFund(
      from.address,
      this.erc20,
      0,
      1,
      this.makeTransferCalldata(to.address),
      100,
    );
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  describe('Token registration', () => {
    it('TOKEN_MANAGER can register a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      const tokenAddress = await token.getAddress();
      await expect(this.extension.connect(this.tokenManager).registerToken(tokenAddress, 50))
        .to.emit(this.extension, 'TokenRegistered')
        .withArgs(tokenAddress, 50);
    });

    it('Non-token-manager cannot register a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.stranger).registerToken(await token.getAddress(), 50),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
    });

    it('Admin without TOKEN_MANAGER role cannot register a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.admin).registerToken(await token.getAddress(), 50),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
    });

    it('Rejects duplicate token registration', async function () {
      await expect(
        this.extension.connect(this.tokenManager).registerToken(await this.erc20.getAddress(), 50),
      ).to.be.revertedWithCustomError(this.extension, 'TokenAlreadyRegistered');
    });
  });

  describe('Leaky bucket boundary conditions', () => {
    async function exhaustBucket(ctx: Mocha.Context) {
      const calldata = ctx.makeTransferCalldata(ethers.Wallet.createRandom().address);
      const [, trackingId] = await ctx.registry
        .connect(ctx.node)
        .chooseFund(ethers.Wallet.createRandom().address, ctx.erc20, 0, 1, calldata, 100);
      for (let i = 0; i < ctx.dailyLimit; i++) {
        await ctx.registry.connect(ctx.node).track(trackingId, 100);
      }
    }

    it('freeTransfersRemaining is capped at dailyLimit after multi-day wait', async function () {
      const erc20Address = await this.erc20.getAddress();
      await exhaustBucket(this);

      await time.increase(2 * 24 * 60 * 60); // 2 full days
      expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(this.dailyLimit);
    });

    // At max uint96 limit, after ~256 days refilled exceeds uint104 max — without the guard in
    // _freeTransfersRemaining, uint104(refilled) would silently truncate to a wrong value.
    it('max uint96 limit after 400 days returns exact limit (no uint104 silent truncation)', async function () {
      const maxUint96 = 2n ** 96n - 1n;
      const token = await ethers.deployContract('TestingERC20', []);
      const tokenAddress = await token.getAddress();
      await this.extension.connect(this.tokenManager).registerToken(tokenAddress, maxUint96);

      await time.increase(400 * 24 * 60 * 60);
      expect(await this.extension.freeTransfersRemaining(tokenAddress)).to.equal(maxUint96);
    });

    it('max uint96 dailyLimit: initial freeTransfersRemaining equals limit', async function () {
      const maxUint96 = 2n ** 96n - 1n;
      const token = await ethers.deployContract('TestingERC20', []);
      const tokenAddress = await token.getAddress();
      await this.extension.connect(this.tokenManager).registerToken(tokenAddress, maxUint96);
      expect(await this.extension.freeTransfersRemaining(tokenAddress)).to.equal(maxUint96);
    });

    // Verifies the underflow guard in track() — calling track when remaining == 0 must be a no-op.
    it('track() is a no-op when bucket is empty', async function () {
      const erc20Address = await this.erc20.getAddress();
      await exhaustBucket(this);
      expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(0);

      const trackingId = ethers.zeroPadValue(ethers.toBeHex((0xf7n << 248n) | BigInt(erc20Address)), 32);
      await expect(this.registry.connect(this.node).track(trackingId, 0)).not.to.be.reverted;
      expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(0);
    });

    it('reducing dailyLimit resets bucket to the new lower limit', async function () {
      const erc20Address = await this.erc20.getAddress();
      const calldata = this.makeTransferCalldata(ethers.Wallet.createRandom().address);
      const [, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(ethers.Wallet.createRandom().address, this.erc20, 0, 1, calldata, 100);
      await this.registry.connect(this.node).track(trackingId, 100);

      const lowerLimit = 3;
      await this.extension.connect(this.tokenManager).setFreeTransfersDailyLimit(erc20Address, lowerLimit);
      expect(await this.extension.freeTransfersRemaining(erc20Address)).to.equal(lowerLimit);
    });
  });

  describe('Removing tokens', () => {
    it('TOKEN_MANAGER can remove a token', async function () {
      const erc20Address = await this.erc20.getAddress();
      await expect(this.extension.connect(this.tokenManager).removeToken(erc20Address))
        .to.emit(this.extension, 'TokenRemoved')
        .withArgs(erc20Address);
    });

    it('Stranger cannot remove a token', async function () {
      await expect(
        this.extension.connect(this.stranger).removeToken(await this.erc20.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
    });

    it('Rejects removal of non-registered token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.tokenManager).removeToken(await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'TokenNotRegistered');
    });

    it('chooseFund returns NONE for removed token', async function () {
      await this.extension.connect(this.tokenManager).removeToken(await this.erc20.getAddress());

      const from = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const [mode] = await this.registry.chooseFund(
        from.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(to.address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });
  });
});
