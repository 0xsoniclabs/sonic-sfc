import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';

const noFundId = '0x0000000000000000000000000000000000000000000000000000000000000000';
const SUBSIDY_MODE_NONE = 0n;
const SUBSIDY_MODE_FUND = 1n;

describe('SubsidiesRegistry', () => {
  const fixture = async () => {
    const [owner, sponsor] = await ethers.getSigners();

    // Deploy a stub SFC contract to copy code from and set at the SFC address
    const stubSfc = await ethers.deployContract('StubSFC', [owner]);
    await ethers.provider.send('hardhat_setCode', [
      '0xFC00FACE00000000000000000000000000000000',
      await stubSfc.getDeployedCode(),
    ]);

    const erc20 = await ethers.deployContract('TestingERC20', []);

    const registry = await upgrades.deployProxy(await ethers.getContractFactory('SubsidiesRegistry'), [], {
      kind: 'uups',
    });

    // Impersonate the Sonic node (address(0)) for testing purposes and fund it
    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await sponsor.sendTransaction({
      to: await node.getAddress(),
      value: ethers.parseEther('10'),
    });

    const cfg = await registry.getGasConfig();
    const config = {
      chooseFundGasLimit: cfg[0],
      deductFeesGasLimit: cfg[1],
      overheadCharge: cfg[2],
    };

    return {
      owner,
      sponsor,
      registry,
      node,
      config,
      erc20,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Should succeed and initialize correctly', async function () {
    expect(await this.registry.owner()).to.equal(await this.owner);
  });

  it('Allows to sponsor and deduct fees', async function () {
    const fundId = '0x0000000000000000000000000000000000000000000000000000000000000015';
    await expect(this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 }))
      .to.emit(this.registry, 'Sponsored')
      .withArgs(fundId, this.sponsor, 100);

    await this.registry.connect(this.node).deductFees(fundId, 90);

    // not enough funds already
    await expect(this.registry.connect(this.node).deductFees(fundId, 11)).to.be.revertedWithCustomError(
      this.registry,
      'NotSponsored',
    );
  });

  describe('Withdrawal', async function () {
    it('Allow to withdraw only what inserted', async function () {
      const fundId = '0x0000000000000000000000000000000000000000000000000000000000000033';
      // insert 100, try to withdraw 500, should only withdraw 100
      await this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 });
      expect(await this.registry.connect(this.sponsor).withdraw(fundId, 500))
        .to.emit(this.registry, 'Withdrawn')
        .withArgs(fundId, this.sponsor, 100);
      // another withdrawal should fail, nothing left to withdraw
      await expect(this.registry.connect(this.sponsor).withdraw(fundId, 500)).to.be.revertedWithCustomError(
        this.registry,
        'NothingToWithdraw',
      );
    });

    it('Allows proportional withdrawal after a partial spend', async function () {
      const fundId = '0x0000000000000000000000000000000000000000000000000000000000000024';
      const [sponsorA, sponsorB] = await ethers.getSigners();

      // Sponsor A deposits 100
      await this.registry.connect(sponsorA).sponsor(fundId, { value: 100 });
      // Sponsor B deposits 200
      await this.registry.connect(sponsorB).sponsor(fundId, { value: 200 });
      expect(await this.registry.getSponsorContribution(fundId, sponsorA)).to.equal(100);
      expect(await this.registry.getSponsorContribution(fundId, sponsorB)).to.equal(200);

      await this.registry.connect(this.node).deductFees(fundId, 30);

      // Now sponsorA should be able to withdraw max 90 (100 - 10% of 100)
      const withdrawableA = await this.registry.availableToWithdraw(fundId, sponsorA);
      expect(withdrawableA).to.equal(90);
      await expect(this.registry.connect(sponsorA).withdraw(fundId, withdrawableA))
        .to.emit(this.registry, 'Withdrawn')
        .withArgs(fundId, sponsorA, withdrawableA);
      expect(await this.registry.getSponsorContribution(fundId, sponsorA)).to.equal(0);

      // SponsorB should be able to withdraw max 180 (200 - 10% of 200)
      const withdrawableB = await this.registry.availableToWithdraw(fundId, sponsorB);
      expect(withdrawableB).to.equal(180);
      await expect(this.registry.connect(sponsorB).withdraw(fundId, withdrawableB))
        .to.emit(this.registry, 'Withdrawn')
        .withArgs(fundId, sponsorB, withdrawableB);
      expect(await this.registry.getSponsorContribution(fundId, sponsorB)).to.equal(0);
    });

    it('Rounding should not allow sponsor to extract more than proportional share', async function () {
      const fundId = '0x0000000000000000000000000000000000000000000000000000000000000099';
      const [, , sponsorA, sponsorB] = await ethers.getSigners();

      // sponsorA deposits 10 wei, sponsorB deposits 7 wei — total contributions = 17
      await this.registry.connect(sponsorA).sponsor(fundId, { value: 10 });
      await this.registry.connect(sponsorB).sponsor(fundId, { value: 7 });

      // Deduct 7 wei in fees: available = 10, totalContributions = 17
      await this.registry.connect(this.node).deductFees(fundId, 7);

      // sponsorA's fair proportional share = floor(10 * 10 / 17) = 5
      const singleShotMax = await this.registry.availableToWithdraw(fundId, sponsorA);
      expect(singleShotMax).to.equal(5n);

      // sponsorA exploits integer rounding by making many 1-wei withdrawals.
      // Each call rounds down toSubtract, so sponsorA loses less contribution
      // credit than they should — allowing them to come back for more.
      for (let i = 0; i < 5; i++) {
        await this.registry.connect(sponsorA).withdraw(fundId, 1);
      }

      // sponsorA should not be able to withdraw more
      await expect(this.registry.connect(sponsorA).withdraw(fundId, 1)).to.be.revertedWithCustomError(
        this.registry,
        'NothingToWithdraw',
      );
    });
  });

  describe('chooseFund', async function () {
    it('Returns zero for unknown tx', async function () {
      const from = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const [mode, choosenFundId] = await this.registry.connect(this.node).chooseFund(from, to, 5, 1, '0x', 5);
      expect(mode).to.equal(SUBSIDY_MODE_NONE);
      expect(choosenFundId).to.equal(noFundId);
    });

    it('Calculates fundId for account sponsorship', async function () {
      const from = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const expectedFundId = await this.registry.accountSponsorshipFundId(from);
      await this.registry.sponsor(expectedFundId, { value: 10 });
      const [mode, chosenFundId] = await this.registry.chooseFund(from, to, 5, 1, '0x', 5);
      expect(mode).to.equal(SUBSIDY_MODE_FUND);
      expect(chosenFundId).to.equal(expectedFundId);
    });

    it('Calculates fundId for account-nonce sponsorship', async function () {
      const from = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const nonce = 123;
      const expectedFundId = await this.registry.accountNonceSponsorshipFundId(from, nonce);
      await this.registry.sponsor(expectedFundId, { value: 10 });
      const [mode, chosenFundId] = await this.registry.chooseFund(from, to, 5, nonce, '0x', 5);
      expect(mode).to.equal(SUBSIDY_MODE_FUND);
      expect(chosenFundId).to.equal(expectedFundId);
    });

    it('Calculates fundId for contract sponsorship', async function () {
      const from = ethers.Wallet.createRandom();
      const to = ethers.Wallet.createRandom();
      const expectedFundId = await this.registry.contractSponsorshipFundId(to);
      await this.registry.sponsor(expectedFundId, { value: 10 });
      const [mode, choosenFundId] = await this.registry.chooseFund(from, to, 5, 1, '0x', 5);
      expect(mode).to.equal(SUBSIDY_MODE_FUND);
      expect(choosenFundId).to.equal(expectedFundId);
    });

    describe('Approval sponsorship', async function () {
      it('Calculates fundId for valid approval', async function () {
        const from = ethers.Wallet.createRandom();
        const spender = ethers.Wallet.createRandom();
        await this.erc20.mint(from, 12); // from has non-zero balance

        const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
        const calldata = approveInterface.encodeFunctionData('approve', [spender.address, 10_000]);

        const expectedFundId = await this.registry.approvalSponsorshipFundId(from, this.erc20, calldata);
        expect(expectedFundId).to.not.equal(noFundId);

        await this.registry.sponsor(expectedFundId, { value: 10 });
        const [mode, choosenFundId] = await this.registry.chooseFund(from, this.erc20, 0, 1, calldata, 5);
        expect(mode).to.equal(SUBSIDY_MODE_FUND);
        expect(choosenFundId).to.equal(expectedFundId);
      });

      it('Does not revert for non-ERC20 target', async function () {
        const from = ethers.Wallet.createRandom();
        const spender = ethers.Wallet.createRandom();
        const to = ethers.Wallet.createRandom(); // target is not an ERC20

        const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
        const calldata = approveInterface.encodeFunctionData('approve', [spender.address, 10_000]);

        const [mode, choosenFundId] = await this.registry.chooseFund(from, to, 0, 1, calldata, 5);
        expect(mode).to.equal(SUBSIDY_MODE_NONE);
        expect(choosenFundId).to.equal(noFundId);
      });

      it('Rejects zero balance from', async function () {
        const from = ethers.Wallet.createRandom();
        const spender = ethers.Wallet.createRandom();

        const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
        const calldata = approveInterface.encodeFunctionData('approve', [spender.address, 10_000]);

        const expectedFundId = await this.registry.approvalSponsorshipFundId(from, this.erc20, calldata);
        expect(expectedFundId).to.equal(noFundId);
      });

      it('Rejects setting allowance when some allowance already set', async function () {
        const [from] = await ethers.getSigners();
        const spender = ethers.Wallet.createRandom();
        await this.erc20.mint(from, 12); // from has non-zero balance
        await this.erc20.connect(from).approve(spender, 3); // spender already have an allowance

        const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
        const calldata = approveInterface.encodeFunctionData('approve', [spender.address, 10_000]);

        const expectedFundId = await this.registry.approvalSponsorshipFundId(from, this.erc20, calldata);
        expect(expectedFundId).to.equal(noFundId);
      });
    });
  });

  describe('deductFees', async function () {
    it('Decreases the balance', async function () {
      const fundId = '0x0000000000000000000000000000000000000000000000000000000000000123';
      await expect(this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 }))
        .to.emit(this.registry, 'Sponsored')
        .withArgs(fundId, this.sponsor, 100);

      await this.registry.connect(this.node).deductFees(fundId, 90);

      expect(await this.registry.getAvailableFunds(fundId)).to.equal(10);

      await this.registry.connect(this.node).deductFees(fundId, 10);

      expect(await this.registry.getAvailableFunds(fundId)).to.equal(0);
    });
  });

  it('Enforces pause', async function () {
    await this.registry.connect(this.owner).pause();
    const fundId = '0x0000000000000000000000000000000000000000000000000000000000000123';
    await expect(this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 })).to.be.revertedWithCustomError(
      this.registry,
      'EnforcedPause',
    );
    await expect(this.registry.connect(this.sponsor).withdraw(fundId, 10)).to.be.revertedWithCustomError(
      this.registry,
      'EnforcedPause',
    );
    await this.registry.connect(this.owner).unpause();
    await expect(this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 }))
      .to.emit(this.registry, 'Sponsored')
      .withArgs(fundId, this.sponsor, 100);
  });

  it('Enforce pause for chooseFund', async function () {
    const from = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom();
    const expectedFundId = await this.registry.contractSponsorshipFundId(to);
    await this.registry.sponsor(expectedFundId, { value: 10 });
    const [mode, choosenFundId] = await this.registry.chooseFund(from, to, 5, 1, '0x', 5);
    expect(mode).to.equal(SUBSIDY_MODE_FUND);
    expect(choosenFundId).to.equal(expectedFundId);

    await this.registry.connect(this.owner).pause();
    const [modePaused, choosenFundIdPaused] = await this.registry.chooseFund(from, to, 5, 1, '0x', 5);
    expect(modePaused).to.equal(SUBSIDY_MODE_NONE);
    expect(choosenFundIdPaused).to.equal(noFundId);
  });

  it('Enforce ownerOnly', async function () {
    const anyAddress = ethers.Wallet.createRandom();
    expect(this.registry.upgradeToAndCall(anyAddress, '0x')).to.be.revertedWithCustomError(
      this.registry,
      'OwnableUnauthorizedAccount',
    );
    expect(this.registry.setChooseFundGasLimit(123)).to.be.revertedWithCustomError(
      this.registry,
      'OwnableUnauthorizedAccount',
    );
    expect(this.registry.setDeductFeesGasLimit(123)).to.be.revertedWithCustomError(
      this.registry,
      'OwnableUnauthorizedAccount',
    );
    expect(this.registry.pause()).to.be.revertedWithCustomError(this.registry, 'OwnableUnauthorizedAccount');
    expect(this.registry.unpause()).to.be.revertedWithCustomError(this.registry, 'OwnableUnauthorizedAccount');

    await this.registry.connect(this.owner).setChooseFundGasLimit(123);
    await this.registry.connect(this.owner).setDeductFeesGasLimit(123);
  });

  describe('getGasConfig', async function () {
    it('getGasConfig fits into 8/10 of GET_GAS_CONFIG_COST', async function () {
      await this.registry.getGasConfig({ gasLimit: (50_000 / 10) * 8 });
    });

    it('chooseFund fits into 8/10 of chooseFundGasLimit', async function () {
      const from = ethers.Wallet.createRandom();
      const spender = ethers.Wallet.createRandom();
      await this.erc20.mint(from, 12); // from has non-zero balance
      const approveInterface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
      const calldata = approveInterface.encodeFunctionData('approve', [spender.address, 10_000]);

      await this.registry
        .connect(this.node)
        .chooseFund(from, this.erc20, 5, 1, calldata, 5, { gasLimit: (this.config.chooseFundGasLimit / 10n) * 8n });
    });

    it('deductFees fits into 8/10 of deductFeesGasLimit', async function () {
      const fundId = '0x0000000000000000000000000000000000000000000000000000000000000123';
      await this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 });

      await this.registry
        .connect(this.node)
        .deductFees(fundId, 90, { gasLimit: (this.config.deductFeesGasLimit / 10n) * 8n });
    });
  });

  describe('Extensions', async function () {
    // extensions are deployed as bare implementations: addExtension only calls the pure trackingIdPrefix()
    it('Adds and removes an extension', async function () {
      const extension = await ethers.deployContract('SenderProjectSubsidies');
      const prefix = await extension.trackingIdPrefix();

      await expect(this.registry.addExtension(extension))
        .to.emit(this.registry, 'ExtensionAdded')
        .withArgs(await extension.getAddress(), prefix);
      expect(await this.registry.extensionsCount()).to.equal(1);
      expect(await this.registry.extensionByPrefix(prefix)).to.equal(await extension.getAddress());

      await expect(this.registry.removeExtension(prefix))
        .to.emit(this.registry, 'ExtensionRemoved')
        .withArgs(await extension.getAddress(), prefix);
      expect(await this.registry.extensionsCount()).to.equal(0);
      expect(await this.registry.extensionByPrefix(prefix)).to.equal(ethers.ZeroAddress);
    });

    it('Rejects adding an extension with an already taken prefix', async function () {
      const extension = await ethers.deployContract('SenderProjectSubsidies');
      const samePrefixExtension = await ethers.deployContract('SenderProjectSubsidies');
      await this.registry.addExtension(extension);
      await expect(this.registry.addExtension(samePrefixExtension)).to.be.revertedWithCustomError(
        this.registry,
        'PrefixAlreadyTaken',
      );
    });

    it('Only owner can add and remove extensions', async function () {
      const extension = await ethers.deployContract('SenderProjectSubsidies');
      await expect(this.registry.connect(this.sponsor).addExtension(extension)).to.be.revertedWithCustomError(
        this.registry,
        'OwnableUnauthorizedAccount',
      );
      await this.registry.addExtension(extension);
      await expect(
        this.registry.connect(this.sponsor).removeExtension(await extension.trackingIdPrefix()),
      ).to.be.revertedWithCustomError(this.registry, 'OwnableUnauthorizedAccount');
    });
  });

  it('Keeps existing storage layout unchanged', async function () {
    // check expected values are set in storage slots to make sure existing slots are unchanged
    await this.registry.setChooseFundGasLimit(0x45b24);
    await this.registry.connect(this.owner).setDeductFeesGasLimit(0xc0b00);
    const fundId = '0x0000000000000000000000000000000000000000000000000000000000012345';
    await this.registry.connect(this.sponsor).sponsor(fundId, { value: 100 });
    await this.registry.connect(this.owner).sponsor(fundId, { value: 5 });
    await this.registry.connect(this.node).deductFees(fundId, 20);

    // chooseFundGasLimit
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ),
    ).to.equal('0x0000000000000000000000000000000000000000000000000000000000045b24');

    // deductFeesGasLimit
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ),
    ).to.equal('0x00000000000000000000000000000000000000000000000000000000000c0b00');

    // sponsorships[fundId].available
    // 100 (sponsor) + 5 (owner) - 20 (deductFees) = 85
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0xc9c9d38ffc86e54587ebbb0f50fbfaeda01172f2ed3d3093531d3abcc205314b',
      ),
    ).to.equal('0x0000000000000000000000000000000000000000000000000000000000000055'); // 85

    // sponsorships[fundId].totalContributions
    // 100 (sponsor) + 5 (owner) = 105
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0xc9c9d38ffc86e54587ebbb0f50fbfaeda01172f2ed3d3093531d3abcc205314c',
      ),
    ).to.equal('0x0000000000000000000000000000000000000000000000000000000000000069'); // 105

    // sponsorships[fundId].contributors[sponsor]
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0xb9fc4c92bf87aa6eea0ca28b75c46112578502a1be8e5f6953c874b662f70f63',
      ),
    ).to.equal('0x0000000000000000000000000000000000000000000000000000000000000064'); // 100

    // sponsorships[fundId].contributors[owner]
    expect(
      await ethers.provider.getStorage(
        this.registry,
        '0x57a558bedd5b3f6e3c80604b7fc322e572f7273949f878b504489dea3e3cb1c3',
      ),
    ).to.equal('0x0000000000000000000000000000000000000000000000000000000000000005'); // 5
  });
});
