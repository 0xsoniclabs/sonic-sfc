// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ISFC} from "../interfaces/ISFC.sol";
import {ISubsidiesRegistry} from "../interfaces/ISubsidiesRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Subsidies Registry Interface
 * @notice Registry managing transaction sponsoring funds.
 * @custom:security-contact security@fantom.foundation
 */
contract SubsidiesRegistry is ISubsidiesRegistry, OwnableUpgradeable, UUPSUpgradeable {
    struct Fund {
        uint256 available;
        uint256 totalContributions;
        mapping(address => uint256) contributors;
    }

    ISFC private constant SFC = ISFC(0xFC00FACE00000000000000000000000000000000);

    /// @notice The cost of getGasConfig() call in the gas units.
    uint256 private constant GET_GAS_CONFIG_COST = 50_000;

    mapping(bytes32 fundId => Fund fund) private sponsorships;

    /// @notice GasLimit to be used for deductFees() calls.
    uint256 public chooseFundGasLimit;

    /// @notice GasLimit to be used for deductFees() transactions.
    uint256 public deductFeesGasLimit;

    event Sponsored(bytes32 indexed fundId, address indexed sponsor, uint256 amount);
    event Withdrawn(bytes32 indexed fundId, address indexed sponsor, uint256 amount);

    error NotNode();
    error NotSponsored();
    error NothingToWithdraw();
    error TransferFailed();
    error NotAllowedInSponsoredTx();
    error ZeroFundId();
    error NoFundsAttached();
    error NotInitialized();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract with an owner and enable upgradability. The owner is copied from the SFC contract.
    function initialize() external initializer {
        __Ownable_init(SFC.owner());
        __UUPSUpgradeable_init();
        chooseFundGasLimit = 100_000;
        deductFeesGasLimit = 100_000;
    }

    /// @notice Account sponsorships cover all transactions sent from a specific account. All sponsorship requests from this account will be covered.
    /// @param from The sender of the transaction
    function accountSponsorshipFundId(address from) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("a", from));
    }

    /// @notice Contract sponsorships cover all transactions sent to a specific contract. All sponsorship requests for transactions targeting this contract will be covered.
    /// @param to The recipient of the transaction (the contract address)
    function contractSponsorshipFundId(address to) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("c", to));
    }

    /// @notice Call sponsorships cover all transactions calling a specific function on a specific contract.
    function operationSponsorshipFundId(address to, bytes calldata callData) public pure returns (bytes32) {
        // Ignore create contract calls (to is zero address) and calls with too short
        // call data (less than 4 bytes, not covering the function selector).
        if (to == address(0) || callData.length < 4) {
            return bytes32(0);
        }
        bytes4 selector = bytes4(callData[:4]);
        return keccak256(abi.encodePacked("o", to, selector));
    }

    /// @notice Account-Operation sponsorships cover all transactions calling a specific function on a specific contract by the given account.
    /// @param from The sender of the transaction
    /// @param to The recipient of the transaction (the contract address)
    /// @param callData The contract call/function signature to be sponsored
    function accountOperationSponsorshipFundId(
        address from,
        address to,
        bytes calldata callData
    ) public pure returns (bytes32) {
        // Ignore create contract calls (to is zero address) and calls with too short
        // call data (less than 4 bytes, not covering the function selector).
        if (to == address(0) || callData.length < 4) {
            return bytes32(0);
        }
        bytes4 selector = bytes4(callData[:4]);
        return keccak256(abi.encodePacked("ao", from, to, selector));
    }

    /// @notice Approval sponsorships cover all ERC20 approve calls giving access to a specific spender.
    /// @param to The recipient of the transaction
    /// @param callData The contract call/function signature to be sponsored
    function approvalSponsorshipFundId(
        address from,
        address to,
        bytes calldata callData
    ) public view returns (bytes32) {
        if (to == address(0) || callData.length != 2 * 32 + 4) {
            return bytes32(0);
        }
        // is ERC20 approval
        if (bytes4(callData[:4]) != IERC20.approve.selector) {
            return bytes32(0);
        }
        // approval has to be for a non-zero value
        (address spender, uint256 value) = abi.decode(callData[4:], (address, uint256));
        if (value == 0) {
            return bytes32(0);
        }
        // user have to use the whole allowance before another approve is sponsored
        {
            (bool allowanceOk, bytes memory allowanceOutput) = to.staticcall(
                abi.encodeWithSelector(IERC20.allowance.selector, from, spender)
            );
            if (!allowanceOk || allowanceOutput.length < 32) {
                return bytes32(0);
            }
            uint256 currentAllowance = abi.decode(allowanceOutput, (uint256));
            if (currentAllowance != 0) {
                return bytes32(0);
            }
        }
        // user's balance have to be non-zero for an approval to be sponsored
        {
            (bool balanceOk, bytes memory balanceOutput) = to.staticcall(
                abi.encodeWithSelector(IERC20.balanceOf.selector, from)
            );
            if (!balanceOk || balanceOutput.length < 32) {
                return bytes32(0);
            }
            uint256 balance = abi.decode(balanceOutput, (uint256));
            if (balance == 0) {
                return bytes32(0);
            }
        }
        return keccak256(abi.encodePacked("approval", to, spender));
    }

    /// @notice Bootstrap sponsorships cover the first few transactions from a new account. This allows new users to get started without having to acquire native tokens first.
    /// @param nonce The transaction nonce
    function bootstrapSponsorshipFund(uint256 nonce) public pure returns (bytes32) {
        // TODO: check that the user balance is below the required fee?
        if (nonce < 3) {
            return keccak256(abi.encodePacked("b"));
        }
        return bytes32(0);
    }

    /// @notice Check if a transaction is covered by Gas Subsidies and return the fund to sponsor it.
    /// @param from Transaction sender
    /// @param to Transaction recipient (typically the called contract, zero for contract creation calls)
    /// @param /*value*/ Transaction value (the money amount being sent to the recipient)
    /// @param nonce Transaction nonce
    /// @param callData Transaction call data
    /// @param fee The transaction fee to be covered
    /// @return fundId The fund to be used to fund the transaction, zero if not covered.
    function chooseFund(
        address from,
        address to,
        uint256 /*value*/,
        uint256 nonce,
        bytes calldata callData,
        uint256 fee
    ) public view returns (bytes32 fundId) {
        // Check all possible sponsorship funds in order of precedence.
        fundId = accountOperationSponsorshipFundId(from, to, callData);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        fundId = approvalSponsorshipFundId(from, to, callData);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        fundId = operationSponsorshipFundId(to, callData);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        fundId = bootstrapSponsorshipFund(nonce);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        fundId = contractSponsorshipFundId(to);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        fundId = accountSponsorshipFundId(from);
        if (fundId != bytes32(0) && sponsorships[fundId].available >= fee) {
            return fundId;
        }
        // No sponsorship found to cover the fee.
        return bytes32(0);
    }

    /// @notice Deduct transaction fees from a sponsorship fund.
    /// @dev This function is intended to be called only by the Sonic node.
    ///      Deducts the fee from the fund balance and burns the native tokens through SFC.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @param fee The fee amount to deduct (in wei).
    function deductFees(bytes32 fundId, uint256 fee) public {
        require(msg.sender == address(0), NotNode()); // must be called in an internal transaction
        require(fundId != bytes32(0), ZeroFundId());
        Fund storage fund = sponsorships[fundId];
        require(fund.available >= fee, NotSponsored());
        fund.available -= fee;
        SFC.burnNativeTokens{value: fee}();
    }

    /// @notice Insert funds into a specified sponsorship fund.
    /// @dev Increases the fund's available balance, the sender's contribution record,
    ///      and the total contributions counter.
    /// @param fundId The unique identifier of the sponsorship fund.
    function sponsor(bytes32 fundId) public payable {
        require(fundId != bytes32(0), ZeroFundId());
        require(msg.value > 0, NoFundsAttached());
        require(owner() != address(0), NotInitialized()); // avoid paying into implementation contract

        Fund storage fund = sponsorships[fundId];
        fund.available += msg.value;
        fund.contributors[msg.sender] += msg.value;
        fund.totalContributions += msg.value;

        emit Sponsored(fundId, msg.sender, msg.value);
    }

    /// @notice Withdraw funds from a sponsorship fund.
    /// @dev A sponsor can withdraw up to their proportional share of the fund's available balance.
    ///      Withdrawals are blocked in sponsored transactions to prevent abuse.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @param amount The requested withdrawal amount (in wei). If larger than the maximum allowed,
    ///        it will be capped to the sponsor's withdrawable share.
    function withdraw(bytes32 fundId, uint256 amount) external {
        require(fundId != bytes32(0), ZeroFundId());
        Fund storage fund = sponsorships[fundId];
        uint256 maxAmount = _availableToWithdraw(fund, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(tx.gasprice != 0, NotAllowedInSponsoredTx());

        uint256 toSubstract = (amount * fund.totalContributions) / fund.available;
        fund.available -= amount;
        fund.contributors[msg.sender] -= toSubstract;
        fund.totalContributions -= toSubstract;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit Withdrawn(fundId, msg.sender, amount);
    }

    /// @notice Get amount of funds available for a sponsor to withdraw from a fund
    /// @param fundId The fund to withdrawn
    /// @param _sponsor The withdrawing sponsor
    function availableToWithdraw(bytes32 fundId, address _sponsor) external view returns (uint256) {
        Fund storage fund = sponsorships[fundId];
        return _availableToWithdraw(fund, _sponsor);
    }

    /// @notice Get amount of funds available for a sponsor to withdraw from a fund
    /// @param fund The fund to withdrawn
    /// @param _sponsor The withdrawing sponsor
    function _availableToWithdraw(Fund storage fund, address _sponsor) private view returns (uint256) {
        if (fund.totalContributions == 0) {
            return 0;
        }
        return (fund.available * fund.contributors[_sponsor]) / fund.totalContributions;
    }

    /// @notice Get the currently available funds for sponsorship under the given fund.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @return The amount of funds (in wei) currently available to cover sponsored transactions.
    function getAvailableFunds(bytes32 fundId) external view returns (uint256) {
        return sponsorships[fundId].available;
    }

    /// @notice Get the total amount of contributions ever made to a given sponsorship fund.
    /// @dev This value increases when sponsors deposit, and decreases proportionally when withdrawals happen.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @return The total contributed amount (in wei) for the specified fund.
    function getTotalContributions(bytes32 fundId) external view returns (uint256) {
        return sponsorships[fundId].totalContributions;
    }

    /// @notice Get the total amount contributed by a specific sponsor to a given fund.
    /// @param fundId The unique identifier of the sponsorship fund.
    /// @param _sponsor The address of the sponsor whose contribution is being queried.
    /// @return The amount (in wei) that the sponsor has contributed to the fund.
    function getSponsorContribution(bytes32 fundId, address _sponsor) external view returns (uint256) {
        return sponsorships[fundId].contributors[_sponsor];
    }

    /// @notice Get gas config for Sonic-internal calls.
    function getGasConfig()
        external
        view
        returns (uint256 _chooseFundGasLimit, uint256 _deductFeesGasLimit, uint256 _overheadCharge)
    {
        _chooseFundGasLimit = chooseFundGasLimit;
        _deductFeesGasLimit = deductFeesGasLimit;
        _overheadCharge = _chooseFundGasLimit + _deductFeesGasLimit + GET_GAS_CONFIG_COST;
        return (_chooseFundGasLimit, _deductFeesGasLimit, _overheadCharge);
    }

    /// @notice Set GasLimit to be used for chooseFund() calls.
    /// @param newLimit The new GasLimit value.
    function setChooseFundGasLimit(uint256 newLimit) external onlyOwner {
        chooseFundGasLimit = newLimit;
    }

    /// @notice Set GasLimit to be used for deductFees() internal transactions.
    /// @param newLimit The new GasLimit value.
    function setDeductFeesGasLimit(uint256 newLimit) external onlyOwner {
        deductFeesGasLimit = newLimit;
    }

    /// Override the upgrade authorization check to allow upgrades only from the owner.
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
