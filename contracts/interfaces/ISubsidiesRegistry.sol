// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/**
 * @title Subsidies Registry Interface
 * @notice Registry managing transaction sponsoring funds.
 * @dev Interface required by the Sonic client for the SubsidiesRegistry contract.
 * @custom:security-contact security@fantom.foundation
 */
interface ISubsidiesRegistry {
    /// @notice Check if a transaction is covered by Gas Subsidies and return the fund to sponsor it.
    /// @param from Transaction sender
    /// @param to Transaction recipient (typically the called contract, zero for contract creation calls)
    /// @param value Transaction value (the money amount being sent to the recipient)
    /// @param nonce Transaction nonce
    /// @param callData Transaction call data
    /// @param fee The transaction fee to be covered
    /// @return fundId The fund to be used to fund the transaction, zero if not covered.
    function chooseFund(
        address from,
        address to,
        uint256 value,
        uint256 nonce,
        bytes calldata callData,
        uint256 fee
    ) external view returns (bytes32 fundId);

    /// @notice Deduct transaction fees from a sponsorship fund.
    /// @dev This function is intended to be called only by the Sonic node.
    ///      Deducts the fee from the fund balance and burns the native tokens through SFC.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @param fee The fee amount to deduct (in wei).
    function deductFees(bytes32 fundId, uint256 fee) external;

    /// @notice Get gas config for Sonic-internal calls.
    function getGasConfig()
        external
        view
        returns (uint256 _chooseFundGasLimit, uint256 _deductFeesGasLimit, uint256 _overheadCharge);
}
