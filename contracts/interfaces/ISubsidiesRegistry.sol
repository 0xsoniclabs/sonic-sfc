// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

// Transaction is not covered by gas subsidies.
uint256 constant SUBSIDY_MODE_NONE = 0;
// Transaction fee is deducted directly from a sponsorship fund.
uint256 constant SUBSIDY_MODE_FUND = 1;
// Transaction fee is tracked and reported via the track() callback.
uint256 constant SUBSIDY_MODE_TRACKED = 3;

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
    /// @return mode Sponsoring mode: SUBSIDY_MODE_FUND, SUBSIDY_MODE_TRACKED, or SUBSIDY_MODE_NONE.
    /// @return payload Fund ID for SUBSIDY_MODE_FUND, tracking ID for SUBSIDY_MODE_TRACKED, zero otherwise.
    function chooseFund(
        address from,
        address to,
        uint256 value,
        uint256 nonce,
        bytes calldata callData,
        uint256 fee
    ) external view returns (uint256 mode, bytes32 payload);

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

    /// @notice Report the gas fee consumed by a network-sponsored tracked transaction.
    /// @dev This function is intended to be called only by the Sonic node - from the zero address.
    /// @param trackingId The tracking ID returned by chooseFund with SUBSIDY_MODE_TRACKED.
    /// @param fee The gas fee consumed by the transaction (in wei).
    function track(bytes32 trackingId, uint256 fee) external;
}
