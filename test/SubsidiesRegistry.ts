import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';

describe('SubsidiesRegistry', () => {
  const fixture = async () => {
    const [owner, sponsor] = await ethers.getSigners();

    // Deploy a stub SFC contract to copy code from and set at the SFC address
    const stubSfc = await ethers.deployContract('StubSFC');
    await ethers.provider.send('hardhat_setCode', [
      '0xFC00FACE00000000000000000000000000000000',
      await stubSfc.getDeployedCode(),
    ]);

    const registry = await upgrades.deployProxy(
      await ethers.getContractFactory('SubsidiesRegistry'),
      [await owner.getAddress()],
      { kind: 'uups' },
    );

    // Impersonate the Sonic node (address(0)) for testing purposes and fund it
    await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
    const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
    await owner.sendTransaction({
      to: await node.getAddress(),
      value: ethers.parseEther('10'),
    });

    return {
      owner,
      sponsor,
      registry,
      node,
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Should succeed and initialize correctly', async function () {
    expect(await this.registry.owner()).to.equal(this.owner);
  });

  describe('UserContract', function () {
    it('Should succeed and sponsor user contract', async function () {
      const [sponsorA, sponsorB, sponsorC] = await ethers.getSigners();
      const from = await this.sponsor.getAddress();
      const contract = ethers.Wallet.createRandom();
      const amount = ethers.parseEther('1');

      let totalSponsored = 0n;
      for (let i = 1n; i <= 3n; i++) {
        for (const sponsor of [sponsorA, sponsorB, sponsorC]) {
          totalSponsored += amount;
          await expect(this.registry.connect(sponsor).sponsorUserContract(from, contract, { value: amount }))
            .to.emit(this.registry, 'UserContractSponsored')
            .withArgs(from, contract, sponsor, amount);
          const sponsorship = await this.registry.userContractSponsorship(from, contract);
          expect(sponsorship.available).to.equal(totalSponsored);
          expect(sponsorship.totalContributions).to.equal(totalSponsored);
          expect(await this.registry.userContractSponsorshipContribution(from, contract, sponsor)).to.equal(amount * i);
        }
      }
    });

    it('Should succeed and un-sponsor user contract', async function () {
      const from = await this.sponsor.getAddress();
      const contract = ethers.Wallet.createRandom();
      const amount = ethers.parseEther('1');
      await this.registry.connect(this.sponsor).sponsorUserContract(from, contract, { value: amount });

      const unsponsorAmounts = [
        ethers.parseEther('0.1'),
        ethers.parseEther('0.2'),
        ethers.parseEther('0.3'),
        ethers.parseEther('0.4'),
      ];
      let totalUnsponsored = 0n;
      for (const unsponsorAmount of unsponsorAmounts) {
        totalUnsponsored += unsponsorAmount;
        await expect(this.registry.connect(this.sponsor).unsponsorUserContract(from, contract, unsponsorAmount))
          .to.emit(this.registry, 'UserContractUnsponsored')
          .withArgs(from, contract, this.sponsor, unsponsorAmount);
        const sponsorship = await this.registry.userContractSponsorship(from, contract);
        expect(sponsorship.available).to.equal(amount - totalUnsponsored);
        expect(sponsorship.totalContributions).to.equal(amount - totalUnsponsored);
        expect(await this.registry.userContractSponsorshipContribution(from, contract, this.sponsor)).to.equal(
          amount - totalUnsponsored,
        );
      }
    });

    it('Should allow proportional withdrawal after partial spend', async function () {
      const [sponsorA, sponsorB] = await ethers.getSigners();
      const from = await this.sponsor.getAddress();
      const contract = ethers.Wallet.createRandom();
      const amountA = ethers.parseEther('100');
      const amountB = ethers.parseEther('200');

      // Sponsor A deposits 100
      await this.registry.connect(sponsorA).sponsorUserContract(from, contract, { value: amountA });
      // Sponsor B deposits 200
      await this.registry.connect(sponsorB).sponsorUserContract(from, contract, { value: amountB });

      const spend = ethers.parseEther('30');
      const data = '0x12345678';
      await this.registry.connect(this.node).deductFees(from, contract, data, spend);

      // Now sponsorA should be able to withdraw max 90 (100 - 10% of 100)
      const withdrawableA = await this.registry.userContractWithdrawable(from, contract, sponsorA);
      expect(withdrawableA).to.equal(ethers.parseEther('90'));
      await this.registry.connect(sponsorA).unsponsorUserContract(from, contract, withdrawableA);
      expect(await this.registry.userContractSponsorshipContribution(from, contract, sponsorA)).to.equal(
        ethers.parseEther('10'),
      );

      // SponsorB should be able to withdraw max 180 (200 - 10% of 200)
      const withdrawableB = await this.registry.userContractWithdrawable(from, contract, sponsorB);
      expect(withdrawableB).to.equal(ethers.parseEther('180'));
      await this.registry.connect(sponsorB).unsponsorUserContract(from, contract, withdrawableB);
      expect(await this.registry.userContractSponsorshipContribution(from, contract, sponsorB)).to.equal(
        ethers.parseEther('20'),
      );
    });
  });

  it('Should succeed and sponsor operation', async function () {
    const contract = ethers.Wallet.createRandom();
    const operationId = '0x12345678';
    const amount = ethers.parseEther('1');
    await expect(this.registry.connect(this.sponsor).sponsorOperation(contract, operationId, { value: amount }))
      .to.emit(this.registry, 'OperationSponsored')
      .withArgs(contract, operationId, this.sponsor, amount);

    const sponsorship = await this.registry.operationSponsorship(contract, operationId);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.operationSponsorshipContribution(contract, operationId, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor contract calls', async function () {
    const contract = ethers.Wallet.createRandom();
    const amount = ethers.parseEther('1');
    await expect(this.registry.connect(this.sponsor).sponsorContract(contract, { value: amount }))
      .to.emit(this.registry, 'ContractSponsored')
      .withArgs(contract, this.sponsor, amount);

    const sponsorship = await this.registry.contractSponsorship(contract);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.contractSponsorshipContribution(contract, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor user calls', async function () {
    const from = ethers.Wallet.createRandom();
    const amount = ethers.parseEther('1');
    await expect(this.registry.connect(this.sponsor).sponsorUser(from, { value: amount }))
      .to.emit(this.registry, 'UserSponsored')
      .withArgs(from, this.sponsor, amount);

    const sponsorship = await this.registry.userSponsorship(from);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.userSponsorshipContribution(from, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor user operation', async function () {
    const from = ethers.Wallet.createRandom();
    const contract = ethers.Wallet.createRandom();
    const operationId = '0x12345678';
    const amount = ethers.parseEther('1');
    await expect(
      this.registry.connect(this.sponsor).sponsorUserOperation(from, contract, operationId, { value: amount }),
    )
      .to.emit(this.registry, 'UserOperationSponsored')
      .withArgs(from, contract, operationId, this.sponsor, amount);

    const sponsorship = await this.registry.userOperationSponsorship(from, contract, operationId);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(
      await this.registry.userOperationSponsorshipContribution(from, contract, operationId, this.sponsor),
    ).to.equal(amount);
  });
});
