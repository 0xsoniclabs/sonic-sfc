import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// npx hardhat ignition deploy ./ignition/modules/SenderProjectSubsidies.ts --strategy create2 --network testnet --deployment-id senderprojects-testnet
// npx hardhat ignition verify senderprojects-testnet

export default buildModule('SenderProjectSubsidiesModule', m => {
  const senderProjectSubsidiesImpl = m.contract('SenderProjectSubsidies', [], {
    id: 'SenderProjectSubsidiesImpl',
  });

  /*
  const senderProjectSubsidiesProxy = m.contract(
    'ERC1967Proxy',
    [senderProjectSubsidiesImpl, m.encodeFunctionCall(senderProjectSubsidiesImpl, 'initialize', [])],
    { id: 'SenderProjectSubsidiesProxy' },
  );
  */

  return { senderProjectSubsidiesImpl };
});
