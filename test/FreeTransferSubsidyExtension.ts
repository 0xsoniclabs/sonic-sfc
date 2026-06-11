import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';

const SUBSIDY_MODE_NONE = 0n;
const SUBSIDY_MODE_TRACKED = 3n;
const noFundId = '0x0000000000000000000000000000000000000000000000000000000000000000';

const SUBSIDIES_REGISTRY = '0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2';

describe('FreeTransfersSubsidyExtension', () => {
  const fixture = async () => {
    const [owner, projectOwner, stranger] = await ethers.getSigners();

    // StubSFC uses immutable owner, so the value is embedded in bytecode after hardhat_setCode
    const stubSfc = await ethers.deployContract('StubSFC', [owner.address]);
    await ethers.provider.send('hardhat_setCode', [
      '0xFC00FACE00000000000000000000000000000000',
      await stubSfc.getDeployedCode(),
    ]);

    const registryFactory = await ethers.getContractFactory('SubsidiesRegistry');
    const implDeploy = await registryFactory.deploy();
    await ethers.provider.send('hardhat_setCode', [
      SUBSIDIES_REGISTRY,
      await ethers.provider.getCode(await implDeploy.getAddress()),
    ]);
    const registry = registryFactory.attach(SUBSIDIES_REGISTRY);
    await registry.initialize();

    // initialize() reads owner from SubsidiesRegistry, so SubsidiesRegistry must be deployed first
    const extension = await upgrades.deployProxy(await ethers.getContractFactory('FreeTransfersSubsidyExtension'), [], {
      kind: 'uups',
    });

    await registry.connect(owner).setDelegate(await extension.getAddress());

    const erc20 = await ethers.deployContract('TestingERC20', []);

    const projectId = 1;
    const dailyLimit = 10;
    await extension.connect(owner).registerProject(projectId, projectOwner.address, dailyLimit);
    await extension.connect(projectOwner).addToken(projectId, await erc20.getAddress());

    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await owner.sendTransaction({ to: await node.getAddress(), value: ethers.parseEther('10') });

    const transferInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const makeTransferCalldata = (to: string) => transferInterface.encodeFunctionData('transfer', [to, 10_000]);

    return {
      owner,
      projectOwner,
      stranger,
      registry,
      extension,
      erc20,
      node,
      makeTransferCalldata,
      projectId,
      dailyLimit,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Allows free transfer via SubsidiesRegistry', async function () {
    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();
    const calldata = this.makeTransferCalldata(to.address);
    const fee = 543;

    expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit);

    const [mode, trackingId] = await this.registry
      .connect(this.node)
      .chooseFund(from.address, this.erc20, 0, 1, calldata, fee);
    expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
    expect(trackingId).to.not.equal(noFundId);
    expect(BigInt(trackingId) >> 248n).to.equal(0xf7n);

    await this.registry.connect(this.node).track(trackingId, fee);
    expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit - 1);
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
    const trackingId = ethers.zeroPadValue(ethers.toBeHex((0xf7n << 248n) | BigInt(this.projectId)), 32);

    await expect(this.extension.connect(this.owner).track(trackingId, 100)).to.be.revertedWithCustomError(
      this.extension,
      'NotNode',
    );
  });

  it('Changing limit resets bucket to full', async function () {
    const newLimit = 20;
    await this.extension.connect(this.owner).setFreeTransfersDailyLimit(this.projectId, newLimit);
    expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(newLimit);
  });

  it('Setting limit to 0 stops sponsorship', async function () {
    await this.extension.connect(this.owner).setFreeTransfersDailyLimit(this.projectId, 0);

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

  describe('Project registration', () => {
    it('Contract owner can register a project', async function () {
      await expect(this.extension.connect(this.owner).registerProject(2, this.stranger.address, 50))
        .to.emit(this.extension, 'ProjectRegistered')
        .withArgs(2, this.stranger.address, 50);
    });

    it('Non-owner cannot register a project', async function () {
      await expect(
        this.extension.connect(this.projectOwner).registerProject(2, this.stranger.address, 50),
      ).to.be.revertedWithCustomError(this.extension, 'OwnableUnauthorizedAccount');
    });

    it('Rejects project ID 0', async function () {
      await expect(
        this.extension.connect(this.owner).registerProject(0, this.stranger.address, 50),
      ).to.be.revertedWithCustomError(this.extension, 'InvalidProjectId');
    });

    it('Rejects zero address as project owner', async function () {
      await expect(
        this.extension.connect(this.owner).registerProject(2, ethers.ZeroAddress, 50),
      ).to.be.revertedWithCustomError(this.extension, 'InvalidOwnerAddress');
    });

    it('Rejects duplicate project ID', async function () {
      await expect(
        this.extension.connect(this.owner).registerProject(this.projectId, this.stranger.address, 50),
      ).to.be.revertedWithCustomError(this.extension, 'ProjectAlreadyExists');
    });
  });

  describe('Adding tokens', () => {
    it('Project owner can add a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(this.extension.connect(this.projectOwner).addToken(this.projectId, await token.getAddress()))
        .to.emit(this.extension, 'TokenAdded')
        .withArgs(this.projectId, await token.getAddress(), this.projectOwner.address);
    });

    it('Contract owner can add a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(this.extension.connect(this.owner).addToken(this.projectId, await token.getAddress()))
        .to.emit(this.extension, 'TokenAdded')
        .withArgs(this.projectId, await token.getAddress(), this.owner.address);
    });

    it('Stranger cannot add a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.stranger).addToken(this.projectId, await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'NotProjectOwner');
    });

    it('Rejects token already assigned to a different project', async function () {
      await this.extension.connect(this.owner).registerProject(2, this.stranger.address, 50);
      await expect(
        this.extension.connect(this.stranger).addToken(2, await this.erc20.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'TokenAlreadyAssigned');
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
      await exhaustBucket(this);

      await time.increase(2 * 24 * 60 * 60); // 2 full days
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit);
    });

    // At max uint96 limit, after ~256 days refilled exceeds uint104 max — without the guard on
    // line 130 of the contract, uint104(refilled) would silently truncate to a wrong value.
    it('max uint96 limit after 400 days returns exact limit (no uint104 silent truncation)', async function () {
      const maxUint96 = 2n ** 96n - 1n;
      await this.extension.connect(this.owner).registerProject(2, this.stranger.address, maxUint96);

      await time.increase(400 * 24 * 60 * 60);
      expect(await this.extension.freeTransfersRemaining(2)).to.equal(maxUint96);
    });

    it('max uint96 dailyLimit: initial freeTransfersRemaining equals limit', async function () {
      const maxUint96 = 2n ** 96n - 1n;
      await this.extension.connect(this.owner).registerProject(2, this.stranger.address, maxUint96);
      expect(await this.extension.freeTransfersRemaining(2)).to.equal(maxUint96);
    });

    // Verifies the underflow guard in track() — calling track when remaining == 0 must be a no-op.
    it('track() is a no-op when bucket is empty', async function () {
      await exhaustBucket(this);
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(0);

      const trackingId = ethers.zeroPadValue(
        ethers.toBeHex((0xf7n << 248n) | BigInt(this.projectId)),
        32,
      );
      await expect(this.registry.connect(this.node).track(trackingId, 0)).not.to.be.reverted;
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(0);
    });

    it('reducing dailyLimit resets bucket to the new lower limit', async function () {
      const calldata = this.makeTransferCalldata(ethers.Wallet.createRandom().address);
      const [, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(ethers.Wallet.createRandom().address, this.erc20, 0, 1, calldata, 100);
      await this.registry.connect(this.node).track(trackingId, 100);

      const lowerLimit = 3;
      await this.extension.connect(this.owner).setFreeTransfersDailyLimit(this.projectId, lowerLimit);
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(lowerLimit);
    });
  });

  describe('Removing tokens', () => {
    it('Project owner can remove a token', async function () {
      await expect(this.extension.connect(this.projectOwner).removeToken(this.projectId, await this.erc20.getAddress()))
        .to.emit(this.extension, 'TokenRemoved')
        .withArgs(this.projectId, await this.erc20.getAddress(), this.projectOwner.address);
    });

    it('Contract owner can remove a token', async function () {
      await expect(this.extension.connect(this.owner).removeToken(this.projectId, await this.erc20.getAddress()))
        .to.emit(this.extension, 'TokenRemoved')
        .withArgs(this.projectId, await this.erc20.getAddress(), this.owner.address);
    });

    it('Stranger cannot remove a token', async function () {
      await expect(
        this.extension.connect(this.stranger).removeToken(this.projectId, await this.erc20.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'NotProjectOwner');
    });

    it('Rejects token not assigned to the project', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.projectOwner).removeToken(this.projectId, await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'TokenNotInProject');
    });

    it('chooseFund returns NONE for removed token', async function () {
      await this.extension.connect(this.projectOwner).removeToken(this.projectId, await this.erc20.getAddress());

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
