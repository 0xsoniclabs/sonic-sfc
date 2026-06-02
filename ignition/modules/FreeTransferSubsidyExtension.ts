import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/FreeTransferSubsidyExtension.ts --strategy create2 --network testnet --deployment-id freetransfers-testnet
// npx hardhat ignition verify freetransfers-testnet

export default buildModule('FreeTransfersSubsidyExtensionModule', m => {
  const FreeTransfersSubsidyExtensionImpl = m.contract('FreeTransfersSubsidyExtension', [], {
    id: 'FreeTransfersSubsidyExtensionImpl',
  });

  /*
  const FreeTransfersSubsidyExtensionProxy = m.contract(
    'ERC1967Proxy',
    [FreeTransfersSubsidyExtensionImpl, m.encodeFunctionCall(FreeTransfersSubsidyExtensionImpl, 'initialize', [])],
    { id: 'FreeTransfersSubsidyExtensionProxy' },
  );
  */

  return { FreeTransfersSubsidyExtensionImpl };
});
