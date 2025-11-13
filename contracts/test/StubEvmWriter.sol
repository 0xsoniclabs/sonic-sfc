// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IEVMWriter} from "../interfaces/IEVMWriter.sol";

contract StubEvmWriter is IEVMWriter {
    event EvmWriterSetBalance(address acc, uint256 value);
    event EvmWriterIncNonce(address acc, uint256 diff);

    function setBalance(address acc, uint256 value) external {
        emit EvmWriterSetBalance(acc, value);
    }

    function incNonce(address acc, uint256 diff) external {
        emit EvmWriterIncNonce(acc, diff);
    }
}
