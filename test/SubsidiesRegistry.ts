import {ethers, upgrades} from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {expect} from "chai";

describe('SubsidiesRegistry', () => {
  const fixture = async () => {
    const [owner, sponsor] = await ethers.getSigners();

    // Deploy a stub SFC contract to set code at the SFC address
    const stubSfc = await ethers.deployContract('StubSFC')
    await ethers.provider.send("hardhat_setCode", [
      "0xFC00FACE00000000000000000000000000000000",
      await stubSfc.getDeployedCode(),
    ]);
    const sfc = await ethers.getContractAt('StubSFC', '0xFC00FACE00000000000000000000000000000000');

    const registry = await upgrades.deployProxy(await ethers.getContractFactory('SubsidiesRegistry'),
        [await owner.getAddress()],
        {kind: 'uups'}
    );

    return {
      owner,
      sponsor,
      sfc,
      registry
    };
  };

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it('Should succeed and initialize correctly', async function () {
    expect(await this.registry.owner()).to.equal(this.owner);
  });

  it('Should succeed and sponsor user contract', async function () {
    const from = await this.sponsor.getAddress();
    const contract = ethers.Wallet.createRandom();
    const amount = ethers.parseEther("1");
    await expect(this.registry.connect(this.sponsor).sponsorUserContract(from, contract, {value: amount}))
        .to.emit(this.registry, 'UserContractSponsored')
        .withArgs(from, contract, this.sponsor, amount);

    const sponsorship = await this.registry.userContractSponsorship(from, contract);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.getUserContractSponsorshipContribution(from, contract, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor operation', async function () {
    const contract = ethers.Wallet.createRandom();
    const operationId = '0x12345678';
    const amount = ethers.parseEther("1");
    await expect(this.registry.connect(this.sponsor).sponsorOperation(contract, operationId, {value: amount}))
        .to.emit(this.registry, 'OperationSponsored')
        .withArgs(contract, operationId, this.sponsor, amount);

    const sponsorship = await this.registry.operationSponsorship(contract, operationId);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.getOperationSponsorshipContribution(contract, operationId, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor contract calls', async function () {
    const contract = ethers.Wallet.createRandom();
    const amount = ethers.parseEther("1");
    await expect(this.registry.connect(this.sponsor).sponsorContract(contract, {value: amount}))
        .to.emit(this.registry, 'ContractSponsored')
        .withArgs(contract, this.sponsor, amount);

    const sponsorship = await this.registry.contractSponsorship(contract);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.getContractSponsorshipContribution(contract, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor user calls', async function () {
    const from = ethers.Wallet.createRandom();
    const amount = ethers.parseEther("1");
    await expect(this.registry.connect(this.sponsor).sponsorUser(from, {value: amount}))
        .to.emit(this.registry, 'UserSponsored')
        .withArgs(from, this.sponsor, amount);

    const sponsorship = await this.registry.userSponsorship(from);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.getUserSponsorshipContribution(from, this.sponsor)).to.equal(amount);
  });

  it('Should succeed and sponsor user operation', async function () {
    const from = ethers.Wallet.createRandom();
    const contract = ethers.Wallet.createRandom();
    const operationId = '0x12345678';
    const amount = ethers.parseEther("1");
    await expect(this.registry.connect(this.sponsor).sponsorUserOperation(from, contract, operationId, {value: amount}))
        .to.emit(this.registry, 'UserOperationSponsored')
        .withArgs(from, contract, operationId, this.sponsor, amount);

    const sponsorship = await this.registry.userOperationSponsorship(from, contract, operationId);
    expect(sponsorship.available).to.equal(amount);
    expect(sponsorship.totalContributions).to.equal(amount);
    expect(await this.registry.getUserOperationSponsorshipContribution(from, contract, operationId, this.sponsor)).to.equal(amount);
  });
});
