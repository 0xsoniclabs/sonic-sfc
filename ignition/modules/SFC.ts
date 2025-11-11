import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/SFC.ts --strategy create2 --network testnet --deployment-id sfc
// npx hardhat ignition verify sfc

export default buildModule('SfcModule', m => {
  const SfcImpl = m.contract('SFC', [], { id: 'SfcImpl' });
  return { SfcImpl };
});
