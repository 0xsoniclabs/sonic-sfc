import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/PriorityRegistry.ts --strategy create2 --network testnet --deployment-id priority-testnet
// npx hardhat ignition verify priority-testnet

export default buildModule('PriorityRegistryModule', m => {
  const priorityRegistryImpl = m.contract('PriorityRegistry', [], { id: 'PriorityRegistryImpl' });

  /*
  const priorityRegistryProxy = m.contract(
    'ERC1967Proxy',
    [priorityRegistryImpl, m.encodeFunctionCall(priorityRegistryImpl, 'initialize', [])],
    { id: 'PriorityRegistryProxy' },
  );
  */

  return { priorityRegistryImpl };
});
