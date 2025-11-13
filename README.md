# Special Fee Contract

The Special Fee Contract (SFC) manages a set of chain validators and their delegations on the Sonic chain.
It receives internal epoch-sealing transactions created by the Sonic node to handle reward distribution.
The communication between the SFC and the Sonic node is mediated by the NodeDriver and NodeDriverAuth contracts.

## Compilation using Docker

Compile contracts:
```
make
```

Run unit tests:
```
make test
```

## Compilation using npm

Install dependencies:
```
npm install
```

Compile contracts:
```
npx hardhat compile
```

Run unit tests:
```
npx hardhat test
npx hardhat test test/SFC.ts   # for a single testsuite
```

Fix formatting:
```
npm run lint:fix
```
