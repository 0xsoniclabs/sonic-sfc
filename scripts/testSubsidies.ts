import { expect } from 'chai';
import { ethers } from 'hardhat';

// Test Gas Subsidies on a live Sonic chain
// This script must run against a real Sonic node (not Hardhat).
// Requirements:
//   * Use --network pointing to a chain where GasSubsidies upgrade is enabled.
//   * Set PRIVATE_KEY env variable to an account holding at least 0.2 S.
// Run as:
// npx hardhat run scripts/testSubsidies.ts --no-compile --network local

async function main() {
  const SUBSIDIES_REGISTRY_ADDRESS = '0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2';

  const subsidiesRegistry = await ethers.getContractAt('SubsidiesRegistry', SUBSIDIES_REGISTRY_ADDRESS);

  const from = ethers.Wallet.createRandom().connect(ethers.provider);
  const spender = ethers.Wallet.createRandom();
  console.log('Subsidized user:', from.address);
  console.log('ERC20 spender:', spender.address);

  const erc20 = await ethers.deployContract('TestingERC20');
  await erc20.waitForDeployment();
  console.log('TestingERC20:', await erc20.getAddress());

  // subsidized user has to have non-zero ERC20 balance - mint
  const mintTx = await erc20.mint(from, 1000n);
  await mintTx.wait();

  const allowanceBefore = await erc20.allowance(from, spender);
  console.log('Allowance before (expected 0n)', allowanceBefore);
  expect(allowanceBefore).to.be.equal(0n);

  const approveCalldata = erc20.interface.encodeFunctionData('approve', [await spender.getAddress(), 100n]);
  const fundId = await subsidiesRegistry.approvalSponsorshipFundId(from, await erc20.getAddress(), approveCalldata);
  console.log('Derived fundId', fundId);

  console.log('Sponsoring...', fundId);
  const sponsorTx = await subsidiesRegistry.sponsor(fundId, { value: ethers.parseEther('0.1') });
  await sponsorTx.wait();

  console.log('Sending sponsored approve tx...');
  const sponsoredTx = await erc20.connect(from).approve(await spender.getAddress(), 123n, {
    gasPrice: 0,
  });
  await sponsoredTx.wait();

  const allowanceAfter = await erc20.allowance(from, spender);
  console.log('Allowance after (expected 123n)', allowanceAfter);
  expect(allowanceAfter).to.be.equal(123n);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
