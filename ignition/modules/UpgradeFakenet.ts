import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

// To upgrade SFC and NodeDriver on locally running fakenet
// npx hardhat ignition deploy ./ignition/modules/UpgradeFakenet.ts --network local --deployment-id local

export default buildModule('UpgradeFakenetModule', m => {
  const nodeDriverImpl = m.contract('NodeDriver', [], { id: 'NodeDriverImpl' });
  const nodeDriverAuthImpl = m.contract('NodeDriverAuth', [], { id: 'NodeDriverAuthImpl' });
  const sfcImpl = m.contract('SFC', [], { id: 'SfcImpl' });

  const nodeDriver = m.contractAt('NodeDriver', '0xd100a01e00000000000000000000000000000000');
  const nodeDriverAuth = m.contractAt('NodeDriverAuth', '0xd100ae0000000000000000000000000000000000');
  const sfc = m.contractAt('SFC', '0xfc00face00000000000000000000000000000000');

  m.call(nodeDriver, 'upgradeToAndCall', [nodeDriverImpl, '0x'], { id: 'upgradeNodeDriver' });
  m.call(nodeDriverAuth, 'upgradeToAndCall', [nodeDriverAuthImpl, '0x'], { id: 'upgradeNodeDriverAuth' });
  m.call(sfc, 'upgradeToAndCall', [sfcImpl, '0x'], { id: 'upgradeSfc' });

  return { nodeDriverImpl, nodeDriverAuthImpl, sfcImpl };
});
