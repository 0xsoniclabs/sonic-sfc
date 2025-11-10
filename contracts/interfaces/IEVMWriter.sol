// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/**
 * @title EVM Writer Interface
 * @notice Allows the NodeDriver contract to write into the state database.
 * @dev Implemented in the native code of the Sonic client.
 * @custom:security-contact security@fantom.foundation
 */
interface IEVMWriter {
    function setBalance(address acc, uint256 value) external;

    function copyCode(address acc, address from) external;

    function incNonce(address acc, uint256 diff) external;
}
