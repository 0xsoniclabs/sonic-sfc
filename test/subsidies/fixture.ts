import { ethers } from 'hardhat';

export const SUBSIDIES_REGISTRY = '0x7d0E23398b6CA0eC7Cdb5b5Aad7F1b11215012d2';

export const subsidiesBaseFixture = async () => {
  const [admin] = await ethers.getSigners();

  // StubSFC uses immutable owner, so the value is embedded in bytecode after hardhat_setCode
  const stubSfc = await ethers.deployContract('StubSFC', [admin.address]);
  await ethers.provider.send('hardhat_setCode', [
    '0xFC00FACE00000000000000000000000000000000',
    await stubSfc.getDeployedCode(),
  ]);

  // deploy the SubsidiesRegistry code at the fixed address expected by extensions
  const registryFactory = await ethers.getContractFactory('SubsidiesRegistry');
  const registryImpl = await registryFactory.deploy();
  await ethers.provider.send('hardhat_setCode', [
    SUBSIDIES_REGISTRY,
    await ethers.provider.getCode(await registryImpl.getAddress()),
  ]);
  const registry = await ethers.getContractAt('SubsidiesRegistry', SUBSIDIES_REGISTRY);
  await registry.initialize();

  await ethers.provider.send('hardhat_impersonateAccount', ['0x0000000000000000000000000000000000000000']);
  const node = await ethers.getSigner('0x0000000000000000000000000000000000000000');
  // allow node to send transactions
  await admin.sendTransaction({ to: await node.getAddress(), value: ethers.parseEther('10') });

  await ethers.provider.send('hardhat_impersonateAccount', [SUBSIDIES_REGISTRY]);
  await ethers.provider.send('hardhat_setBalance', [SUBSIDIES_REGISTRY, ethers.toBeHex(ethers.parseEther('1'))]);
  const registrySigner = await ethers.getSigner(SUBSIDIES_REGISTRY);

  return { admin, registry, node, registrySigner };
};
