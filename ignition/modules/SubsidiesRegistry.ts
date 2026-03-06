import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/SubsidiesRegistry.ts --strategy create2 --network testnet --deployment-id subsidies-testnet
// npx hardhat ignition verify subsidies-testnet

export default buildModule('SubsidiesRegistryModule', m => {
  const subsidiesRegistryImpl = m.contract('SubsidiesRegistry', [], { id: 'SubsidiesRegistryImpl' });

  /*
  const subsidiesRegistryProxy = m.contract(
    'ERC1967Proxy',
    [subsidiesRegistryImpl, m.encodeFunctionCall(subsidiesRegistryImpl, 'initialize', [])],
    { id: 'SubsidiesRegistryProxy' },
  );
  */

  return { subsidiesRegistryImpl };
});
