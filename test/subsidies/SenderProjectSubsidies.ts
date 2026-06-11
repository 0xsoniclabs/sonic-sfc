import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { subsidiesBaseFixture } from './fixture';

const SUBSIDY_MODE_NONE = 0n;
const SUBSIDY_MODE_TRACKED = 3n;
const noFundId = '0x0000000000000000000000000000000000000000000000000000000000000000';

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const PROJECT_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('PROJECT_MANAGER_ROLE'));
const SENDER_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SENDER_MANAGER_ROLE'));
const WHITELIST_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('WHITELIST_MANAGER_ROLE'));

describe('SenderProjectSubsidies', () => {
  const fixture = async () => {
    const { admin, registry, node, registrySigner } = await loadFixture(subsidiesBaseFixture);
    const [, projectManager, sendersManager, whitelistManager, stranger] = await ethers.getSigners();
    const sender = ethers.Wallet.createRandom();

    const extension = await upgrades.deployProxy(await ethers.getContractFactory('SenderProjectSubsidies'), [], {
      kind: 'uups',
    });
    await registry.connect(admin).addExtension(await extension.getAddress());

    await extension.connect(admin).grantRole(PROJECT_MANAGER_ROLE, projectManager.address);
    await extension.connect(admin).grantRole(SENDER_MANAGER_ROLE, sendersManager.address);
    await extension.connect(admin).grantRole(WHITELIST_MANAGER_ROLE, whitelistManager.address);

    const erc20 = await ethers.deployContract('TestingERC20', []);

    const projectId = 1;
    const dailyLimit = 10;
    await extension.connect(projectManager).registerProject(projectId, dailyLimit);
    await extension.connect(whitelistManager).whitelistToken(await erc20.getAddress());
    await extension.connect(sendersManager).addSender(projectId, sender.address);

    const transferInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const makeTransferCalldata = (to: string) => transferInterface.encodeFunctionData('transfer', [to, 10_000]);

    return {
      admin,
      projectManager,
      sendersManager,
      whitelistManager,
      stranger,
      sender,
      registry,
      registrySigner,
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

  it('Reports its tracking ID prefix', async function () {
    expect(await this.extension.trackingIdPrefix()).to.equal(0xf6);
  });

  it('Allows free ERC-20 transfer for registered sender', async function () {
    const to = ethers.Wallet.createRandom();
    const calldata = this.makeTransferCalldata(to.address);
    const fee = 543;

    expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit);

    const [mode, trackingId] = await this.registry
      .connect(this.node)
      .chooseFund(this.sender.address, this.erc20, 0, 1, calldata, fee);
    expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
    expect(trackingId).to.not.equal(noFundId);
    expect(BigInt(trackingId) >> 248n).to.equal(0xf6n);

    await this.registry.connect(this.node).track(trackingId, fee);
    expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit - 1);
  });

  it('Rejects ERC-20 transfer from unregistered sender', async function () {
    const unregistered = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();

    const [mode] = await this.registry.chooseFund(
      unregistered.address,
      this.erc20,
      0,
      1,
      this.makeTransferCalldata(to.address),
      100,
    );
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  it('Rejects transfer of non-whitelisted token from registered sender', async function () {
    const otherToken = await ethers.deployContract('TestingERC20', []);
    const to = ethers.Wallet.createRandom();

    const [mode] = await this.registry.chooseFund(
      this.sender.address,
      otherToken,
      0,
      1,
      this.makeTransferCalldata(to.address),
      100,
    );
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  it('Rejects approve call data', async function () {
    const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
    const calldata = approveInterface.encodeFunctionData('approve', [this.sender.address, 1_000]);

    const [mode] = await this.registry.chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
    expect(mode).to.equal(SUBSIDY_MODE_NONE);
  });

  describe('Native transfers', () => {
    it('Allows native transfer from registered sender when NATIVE_TOKEN is whitelisted', async function () {
      await this.extension.connect(this.whitelistManager).whitelistToken(NATIVE_TOKEN);

      const recipient = ethers.Wallet.createRandom();
      const [mode, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(this.sender.address, recipient.address, 1000, 1, '0x', 100);
      expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
      expect(BigInt(trackingId) >> 248n).to.equal(0xf6n);

      // consumes from the same project bucket as ERC-20 transfers
      await this.registry.connect(this.node).track(trackingId, 100);
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit - 1);
    });

    it('Rejects native transfer when NATIVE_TOKEN is not whitelisted', async function () {
      const recipient = ethers.Wallet.createRandom();
      const [mode] = await this.registry.chooseFund(this.sender.address, recipient.address, 1000, 1, '0x', 100);
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Rejects native transfer from unregistered sender', async function () {
      await this.extension.connect(this.whitelistManager).whitelistToken(NATIVE_TOKEN);

      const unregistered = ethers.Wallet.createRandom();
      const recipient = ethers.Wallet.createRandom();
      const [mode] = await this.registry.chooseFund(unregistered.address, recipient.address, 1000, 1, '0x', 100);
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Rejects native transfer with zero value', async function () {
      await this.extension.connect(this.whitelistManager).whitelistToken(NATIVE_TOKEN);

      const recipient = ethers.Wallet.createRandom();
      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        recipient.address,
        0, // zero value
        1,
        '0x',
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Rejects native transfer with non-empty calldata', async function () {
      await this.extension.connect(this.whitelistManager).whitelistToken(NATIVE_TOKEN);

      const recipient = ethers.Wallet.createRandom();
      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        recipient.address,
        1000,
        1,
        '0xdeadbeef', // non-empty calldata
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });
  });

  describe('Token whitelist', () => {
    it('WHITELIST_MANAGER can whitelist a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      const tokenAddress = await token.getAddress();
      await expect(this.extension.connect(this.whitelistManager).whitelistToken(tokenAddress))
        .to.emit(this.extension, 'TokenWhitelisted')
        .withArgs(tokenAddress);
    });

    it('Stranger cannot add or remove a token', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.stranger).whitelistToken(await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
      await expect(
        this.extension.connect(this.stranger).removeTokenFromWhitelist(await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
    });

    it('Rejects duplicate whitelisting', async function () {
      await expect(
        this.extension.connect(this.whitelistManager).whitelistToken(await this.erc20.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'TokenAlreadyWhitelisted');
    });

    it('WHITELIST_MANAGER can remove a token from the whitelist', async function () {
      const erc20Address = await this.erc20.getAddress();
      await expect(this.extension.connect(this.whitelistManager).removeTokenFromWhitelist(erc20Address))
        .to.emit(this.extension, 'TokenRemovedFromWhitelist')
        .withArgs(erc20Address);
    });

    it('Rejects removing a token that is not whitelisted', async function () {
      const token = await ethers.deployContract('TestingERC20', []);
      await expect(
        this.extension.connect(this.whitelistManager).removeTokenFromWhitelist(await token.getAddress()),
      ).to.be.revertedWithCustomError(this.extension, 'TokenNotWhitelisted');
    });

    it('Removed token is no longer sponsored', async function () {
      await this.extension.connect(this.whitelistManager).removeTokenFromWhitelist(await this.erc20.getAddress());

      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });
  });

  describe('Registry extension routing', () => {
    it('chooseFund falls through to the next extension', async function () {
      // TokenTransferSubsidies (prefix 0xF7) registered as the second extension
      const tokenSubsidies = await upgrades.deployProxy(await ethers.getContractFactory('TokenTransferSubsidies'), [], {
        kind: 'uups',
      });
      const TOKEN_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TOKEN_MANAGER_ROLE'));
      await tokenSubsidies.connect(this.admin).grantRole(TOKEN_MANAGER_ROLE, this.admin.address);
      const erc20Address = await this.erc20.getAddress();
      await tokenSubsidies.connect(this.admin).registerToken(erc20Address, 5);
      await this.registry.connect(this.admin).addExtension(await tokenSubsidies.getAddress());

      // sender unknown to SenderProjectSubsidies -> falls through to TokenTransferSubsidies
      const unregistered = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const [mode, trackingId] = await this.registry.chooseFund(
        unregistered.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(to.address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
      expect(BigInt(trackingId) >> 248n).to.equal(0xf7n);

      // track is routed by prefix to TokenTransferSubsidies
      await this.registry.connect(this.node).track(trackingId, 100);
      expect(await tokenSubsidies.freeTransfersRemaining(erc20Address)).to.equal(4);
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(this.dailyLimit);
    });

    it('First extension sponsoring the transaction wins', async function () {
      // TokenTransferSubsidies sponsoring the same token, added after SenderProjectSubsidies
      const tokenSubsidies = await upgrades.deployProxy(await ethers.getContractFactory('TokenTransferSubsidies'), [], {
        kind: 'uups',
      });
      const TOKEN_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TOKEN_MANAGER_ROLE'));
      await tokenSubsidies.connect(this.admin).grantRole(TOKEN_MANAGER_ROLE, this.admin.address);
      await tokenSubsidies.connect(this.admin).registerToken(await this.erc20.getAddress(), 5);
      await this.registry.connect(this.admin).addExtension(await tokenSubsidies.getAddress());

      // registered sender -> both extensions would sponsor, SenderProjectSubsidies (added first) wins
      const [mode, trackingId] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
      expect(BigInt(trackingId) >> 248n).to.equal(0xf6n);

      // unknown sender -> only TokenTransferSubsidies sponsors
      const [tokenMode, tokenTrackingId] = await this.registry.chooseFund(
        ethers.Wallet.createRandom().address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(tokenMode).to.equal(SUBSIDY_MODE_TRACKED);
      expect(BigInt(tokenTrackingId) >> 248n).to.equal(0xf7n);
    });

    it('Removed extension no longer sponsors nor tracks', async function () {
      await this.registry.connect(this.admin).removeExtension(0xf6);
      expect(await this.registry.extensionsCount()).to.equal(0);

      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);

      const trackingId = ethers.zeroPadValue(ethers.toBeHex((0xf6n << 248n) | BigInt(this.projectId)), 32);
      await expect(this.registry.connect(this.node).track(trackingId, 100)).to.be.revertedWithCustomError(
        this.registry,
        'NotSponsored',
      );
    });

    it('Extension track rejects a foreign prefix', async function () {
      const foreignTrackingId = ethers.zeroPadValue(ethers.toBeHex((0xf7n << 248n) | 1n), 32);
      await expect(
        this.extension.connect(this.registrySigner).track(foreignTrackingId, 100),
      ).to.be.revertedWithCustomError(this.extension, 'InvalidTrackingId');
    });
  });

  describe('Leaky bucket', () => {
    it('Enforces rate limit', async function () {
      const to = ethers.Wallet.createRandom();
      const calldata = this.makeTransferCalldata(to.address);

      for (let i = 0; i < this.dailyLimit; i++) {
        const [mode, trackingId] = await this.registry
          .connect(this.node)
          .chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
        expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
        await this.registry.connect(this.node).track(trackingId, 100);
      }

      const [modeExhausted] = await this.registry.chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
      expect(modeExhausted).to.equal(SUBSIDY_MODE_NONE);

      await time.increase(12 * 60 * 60); // half a day

      const halfLimit = Math.floor(this.dailyLimit / 2);
      for (let i = 0; i < halfLimit; i++) {
        const [mode, trackingId] = await this.registry
          .connect(this.node)
          .chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
        expect(mode).to.equal(SUBSIDY_MODE_TRACKED);
        await this.registry.connect(this.node).track(trackingId, 100);
      }

      const [modeHalf] = await this.registry.chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
      expect(modeHalf).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Two senders in the same project share one bucket', async function () {
      const sender2 = ethers.Wallet.createRandom();
      await this.extension.connect(this.sendersManager).addSender(this.projectId, sender2.address);

      const calldata = this.makeTransferCalldata(ethers.Wallet.createRandom().address);

      for (let i = 0; i < this.dailyLimit / 2; i++) {
        const [, id1] = await this.registry
          .connect(this.node)
          .chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
        await this.registry.connect(this.node).track(id1, 100);
        const [, id2] = await this.registry
          .connect(this.node)
          .chooseFund(sender2.address, this.erc20, 0, 1, calldata, 100);
        await this.registry.connect(this.node).track(id2, 100);
      }

      // bucket exhausted — neither sender should be sponsored
      const [mode1] = await this.registry.chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
      const [mode2] = await this.registry.chooseFund(sender2.address, this.erc20, 0, 1, calldata, 100);
      expect(mode1).to.equal(SUBSIDY_MODE_NONE);
      expect(mode2).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Setting limit to 0 stops sponsorship', async function () {
      await this.extension.connect(this.projectManager).setFreeTransfersDailyLimit(this.projectId, 0);

      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });

    it('track is a no-op when bucket is empty', async function () {
      const calldata = this.makeTransferCalldata(ethers.Wallet.createRandom().address);
      const [, trackingId] = await this.registry
        .connect(this.node)
        .chooseFund(this.sender.address, this.erc20, 0, 1, calldata, 100);
      for (let i = 0; i < this.dailyLimit; i++) {
        await this.registry.connect(this.node).track(trackingId, 100);
      }
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(0);

      await expect(this.registry.connect(this.node).track(trackingId, 100)).not.to.be.reverted;
      expect(await this.extension.freeTransfersRemaining(this.projectId)).to.equal(0);
    });
  });

  describe('Project management', () => {
    it('PROJECT_MANAGER can register a project', async function () {
      await expect(this.extension.connect(this.projectManager).registerProject(2, 50))
        .to.emit(this.extension, 'ProjectRegistered')
        .withArgs(2, 50);
    });

    it('Non-project-manager cannot register a project', async function () {
      await expect(this.extension.connect(this.stranger).registerProject(2, 50)).to.be.revertedWithCustomError(
        this.extension,
        'AccessControlUnauthorizedAccount',
      );
    });

    it('Rejects project ID 0', async function () {
      await expect(this.extension.connect(this.projectManager).registerProject(0, 50)).to.be.revertedWithCustomError(
        this.extension,
        'InvalidProjectId',
      );
    });

    it('Rejects duplicate project ID', async function () {
      await expect(
        this.extension.connect(this.projectManager).registerProject(this.projectId, 50),
      ).to.be.revertedWithCustomError(this.extension, 'ProjectAlreadyExists');
    });

    it('PROJECT_MANAGER can remove a project', async function () {
      await expect(this.extension.connect(this.projectManager).removeProject(this.projectId))
        .to.emit(this.extension, 'ProjectRemoved')
        .withArgs(this.projectId);
    });

    it('Removed project stops sponsoring its senders', async function () {
      await this.extension.connect(this.projectManager).removeProject(this.projectId);

      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });
  });

  describe('Sender management', () => {
    it('SENDER_MANAGER can add a sender', async function () {
      const newSender = ethers.Wallet.createRandom();
      await expect(this.extension.connect(this.sendersManager).addSender(this.projectId, newSender.address))
        .to.emit(this.extension, 'SenderAdded')
        .withArgs(this.projectId, newSender.address);
    });

    it('Non-sender-manager cannot add a sender', async function () {
      await expect(
        this.extension.connect(this.stranger).addSender(this.projectId, ethers.Wallet.createRandom().address),
      ).to.be.revertedWithCustomError(this.extension, 'AccessControlUnauthorizedAccount');
    });

    it('Rejects adding sender to non-existent project', async function () {
      await expect(
        this.extension.connect(this.sendersManager).addSender(999, this.sender.address),
      ).to.be.revertedWithCustomError(this.extension, 'ProjectNotFound');
    });

    it('Rejects duplicate sender registration', async function () {
      await expect(
        this.extension.connect(this.sendersManager).addSender(this.projectId, this.sender.address),
      ).to.be.revertedWithCustomError(this.extension, 'SenderAlreadyAssigned');
    });

    it('SENDER_MANAGER can remove a sender', async function () {
      await expect(this.extension.connect(this.sendersManager).removeSender(this.sender.address))
        .to.emit(this.extension, 'SenderRemoved')
        .withArgs(this.sender.address);
    });

    it('Removed sender is no longer sponsored', async function () {
      await this.extension.connect(this.sendersManager).removeSender(this.sender.address);

      const [mode] = await this.registry.chooseFund(
        this.sender.address,
        this.erc20,
        0,
        1,
        this.makeTransferCalldata(ethers.Wallet.createRandom().address),
        100,
      );
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
    });

    it('Rejects removing unregistered sender', async function () {
      await expect(
        this.extension.connect(this.sendersManager).removeSender(ethers.Wallet.createRandom().address),
      ).to.be.revertedWithCustomError(this.extension, 'SenderNotAssigned');
    });
  });

  it('Rejects track call not from SubsidiesRegistry', async function () {
    const trackingId = ethers.zeroPadValue(ethers.toBeHex((0xf6n << 248n) | BigInt(this.projectId)), 32);
    await expect(this.extension.connect(this.admin).track(trackingId, 100)).to.be.revertedWithCustomError(
      this.extension,
      'NotSubsidiesRegistry',
    );
  });
});
