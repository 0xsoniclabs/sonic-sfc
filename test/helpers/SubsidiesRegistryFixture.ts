import { ethers } from 'hardhat';
import { SubsidiesRegistry } from '../../typechain-types';

export const SUBSIDIES_REGISTRY = '0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2';

/// Deploys the SubsidiesRegistry code to its fixed address expected by the extension contracts.
/// All test files share one Hardhat network, so the storage at the fixed address survives
/// between files — initialization and registered extensions left over by another test file's
/// fixture have to be cleaned up.
export async function deploySubsidiesRegistryAtFixedAddress(): Promise<SubsidiesRegistry> {
  const registryFactory = await ethers.getContractFactory('SubsidiesRegistry');
  const implDeploy = await registryFactory.deploy();
  await ethers.provider.send('hardhat_setCode', [
    SUBSIDIES_REGISTRY,
    await ethers.provider.getCode(await implDeploy.getAddress()),
  ]);
  const registry = registryFactory.attach(SUBSIDIES_REGISTRY) as SubsidiesRegistry;

  try {
    await registry.initialize();
  } catch {
    // already initialized by another test file sharing the fixed address
  }

  // remove extensions registered by other test files
  while ((await registry.extensionsCount()) > 0n) {
    const extension = await ethers.getContractAt('ISubsidiesExtension', await registry.extensions(0));
    await registry.removeExtension(await extension.trackingIdPrefix());
  }

  return registry;
}
