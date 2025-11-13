import { ethers } from 'hardhat';

// Issue native tokens to a specific address on the local testing network:
// (requires .env with appropriate PRIVATE_KEY)
// npx hardhat run scripts/issueTokens.ts --no-compile --network local

async function main() {
  const SFC_ADDRESS = '0xfc00face00000000000000000000000000000000';
  const TARGET_ADDRESS = '0xfc00face00000000000000000000000000000012'; // must be different from signer, otherwise reverts

  const [signer] = await ethers.getSigners();
  console.log('Using signer:', signer.address);

  const sfc = await ethers.getContractAt('SFC', SFC_ADDRESS, signer);
  const constsAddress = await sfc.constsAddress();
  console.log('ConstantsManager:', constsAddress);

  const consts = await ethers.getContractAt('ConstantsManager', constsAddress, signer);
  const tx1 = await consts.updateIssuedTokensRecipient(TARGET_ADDRESS);
  await tx1.wait();
  console.log('ConstantsManager.issuedTokensRecipient set to ', TARGET_ADDRESS);

  const amount = ethers.parseEther('100');
  const tx2 = await sfc.issueTokens(amount);
  await tx2.wait();
  console.log('Issued ', ethers.formatEther(amount), ' tokens');

  console.log('New balance ', ethers.formatEther(await ethers.provider.getBalance(TARGET_ADDRESS)));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
