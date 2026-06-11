// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/**
 * @title Subsidies Registry Extension Interface
 * @notice Extension of the registry managing transaction sponsoring funds.
 * @custom:security-contact security@fantom.foundation
 */
interface ISubsidiesExtension {
    /// @notice The top-byte prefix this extension embeds into its tracking IDs.
    /// @dev The SubsidiesRegistry uses it to route track() calls to the issuing extension.
    ///      Must be unique among extensions registered in the SubsidiesRegistry.
    function trackingIdPrefix() external view returns (uint8);

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

    /// @notice Report the gas fee consumed by a network-sponsored tracked transaction.
    /// @dev This function is intended to be called only by the Sonic node - from the zero address.
    /// @param trackingId The tracking ID returned by chooseFund with SUBSIDY_MODE_TRACKED.
    /// @param fee The gas fee consumed by the transaction (in wei).
    function track(bytes32 trackingId, uint256 fee) external;
}
