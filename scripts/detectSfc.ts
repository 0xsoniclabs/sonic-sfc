import { ethers } from 'hardhat';
import { AddressLike } from 'ethers';

// Detect NodeDriver and SFC used on the given chain:
// npx hardhat run scripts/detectSfc.ts --no-compile --network local

async function main() {
  const NODE_DRIVER_ADDRESS = '0xd100a01e00000000000000000000000000000000';
  const SUBSIDIES_REGISTRY_ADDRESS = '0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2';
  const ZERO_SLOT = '0x' + '0'.repeat(64);

  const nodeDriver = await ethers.getContractAt('NodeDriver', NODE_DRIVER_ADDRESS);
  console.log('NodeDriver: ', NODE_DRIVER_ADDRESS);
  console.log(' - implementation: ', await getImplementation(nodeDriver));
  console.log(' - owner: ', await nodeDriver.owner());

  const nodeDriverAuthAddress = storageToAddress(await ethers.provider.getStorage(nodeDriver, ZERO_SLOT));
  const nodeDriverAuth = await ethers.getContractAt('NodeDriverAuth', nodeDriverAuthAddress);
  console.log('NodeDriverAuth: ', nodeDriverAuthAddress);
  console.log(' - implementation: ', await getImplementation(nodeDriverAuth));
  console.log(' - owner: ', await nodeDriverAuth.owner());

  const sfcAddress = storageToAddress(await ethers.provider.getStorage(nodeDriverAuth, ZERO_SLOT));
  const sfc = await ethers.getContractAt('SFC', sfcAddress);
  console.log('SFC: ', sfcAddress);
  console.log(' - implementation: ', await getImplementation(sfc));
  console.log(' - owner: ', await sfc.owner());
  console.log(' - lastValidatorID: ', (await sfc.lastValidatorID()).toString());

  const constantsManagerAddress = await sfc.constsAddress();
  const constantsManager = await ethers.getContractAt('ConstantsManager', constantsManagerAddress);
  console.log('ConstantsManager:', constantsManagerAddress);
  console.log(' - owner: ', await constantsManager.owner());
  console.log(' - issuedTokensRecipient: ', await constantsManager.issuedTokensRecipient());

  const subsidiesRegistry = await ethers.getContractAt('SubsidiesRegistry', SUBSIDIES_REGISTRY_ADDRESS);
  console.log('SubsidiesRegistry: ', SUBSIDIES_REGISTRY_ADDRESS);
  console.log(' - implementation: ', await getImplementation(subsidiesRegistry));
  console.log(' - owner: ', await subsidiesRegistry.owner());
  console.log(' - getGasConfig: ', await subsidiesRegistry.getGasConfig());
}

function storageToAddress(storageSlot: string): string {
  return ethers.AbiCoder.defaultAbiCoder().decode(['address'], storageSlot)[0];
}

async function getImplementation(address: AddressLike): Promise<string> {
  const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
  return storageToAddress(await ethers.provider.getStorage(address, IMPLEMENTATION_SLOT));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
