// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/**
 * @title Priority Registry Interface
 * @notice Registry managing transaction prioritization on the Sonic chain.
 * @dev Interface required by the Sonic client for the PriorityRegistry contract.
 * @custom:security-contact security@fantom.foundation
 */
interface IPriorityRegistry {
    /**
     * @notice Get the priority of a transaction.
     * @param from Transaction sender.
     * @param to Transaction recipient (typically the called contract, zero for contract creation calls).
     * @param value Transaction value (the money amount being sent to the recipient).
     * @param nonce Transaction nonce.
     * @param callData Transaction call data.
     * @param gasLimit Transaction gas limit; lets the registry exclude oversized transactions.
     * @return level Priority level: 0 = no priority; > 0 = prioritized, higher levels go first.
     * @return weight Tie-breaker within a level - higher weights go first.
     * @return id Entity identifier; transactions sharing an id are rate-limited together.
     */
    function getPriority(
        address from,
        address to,
        uint256 value,
        uint256 nonce,
        bytes calldata callData,
        uint256 gasLimit
    ) external view returns (uint256 level, uint256 weight, bytes32 id);

    /**
     * @notice Get the per-entity rate limits enforced by the node.
     * @return maxGasPerEntityPerBlock Total gas budget of an entity's prioritized transactions within a single block.
     * @return maxPiggybackTxsPerEntityPerEvent Cap on foreign emitter prioritized transactions.
     */
    function getPriorityConfig()
        external
        view
        returns (uint256 maxGasPerEntityPerBlock, uint256 maxPiggybackTxsPerEntityPerEvent);
}
