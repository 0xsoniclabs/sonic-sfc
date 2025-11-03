import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/NodeDriverAuth.ts --strategy create2 --network testnet --deployment-id driver
// npx hardhat ignition verify driver

export default buildModule('NodeDriverAuthModule', m => {
  const NodeDriverAuthImpl = m.contract('NodeDriverAuth', [], { id: 'NodeDriverAuthImpl' });
  return { NodeDriverAuthImpl };
});
