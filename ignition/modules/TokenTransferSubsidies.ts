import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/TokenTransferSubsidies.ts --strategy create2 --network testnet --deployment-id tokentransfers-testnet
// npx hardhat ignition verify tokentransfers-testnet

export default buildModule('TokenTransferSubsidiesModule', m => {
  const tokenTransferSubsidiesImpl = m.contract('TokenTransferSubsidies', [], {
    id: 'TokenTransferSubsidiesImpl',
  });

  /*
  const tokenTransferSubsidiesProxy = m.contract(
    'ERC1967Proxy',
    [tokenTransferSubsidiesImpl, m.encodeFunctionCall(tokenTransferSubsidiesImpl, 'initialize', [])],
    { id: 'TokenTransferSubsidiesProxy' },
  );
  */

  return { tokenTransferSubsidiesImpl };
});
