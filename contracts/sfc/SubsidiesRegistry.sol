// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ISFC} from "../interfaces/ISFC.sol";

contract SubsidiesRegistry is OwnableUpgradeable, UUPSUpgradeable {
    struct Sponsorship {
        uint256 available;
        uint256 totalContributions;
        mapping(address => uint256) contributors;
    }

    ISFC private constant SFC = ISFC(0xFC00FACE00000000000000000000000000000000);

    // User-Contract sponsorship: From -> To -> Sponsorship
    mapping(address from => mapping(address to => Sponsorship)) public userContractSponsorship;

    // Operation sponsorship: To -> Operation Signature -> Sponsorship
    mapping(address to => mapping(bytes4 operation => Sponsorship)) public operationSponsorship;

    // Contract sponsorship: To -> Sponsorship
    mapping(address to => Sponsorship) public contractSponsorship;

    // User sponsorship: From -> Sponsorship
    mapping(address from => Sponsorship) public userSponsorship;

    // User-Operation sponsorship: From -> To -> Operation Signature -> Sponsorship
    mapping(address from => mapping(address to => mapping(bytes4 operation => Sponsorship)))
        public userOperationSponsorship;

    event UserContractSponsored(address indexed from, address indexed to, address indexed sponsor, uint256 amount);
    event UserContractUnsponsored(address indexed from, address indexed to, address indexed sponsor, uint256 amount);
    event OperationSponsored(address indexed to, bytes4 indexed operation, address indexed sponsor, uint256 amount);
    event OperationUnsponsored(address indexed to, bytes4 indexed operation, address indexed sponsor, uint256 amount);
    event ContractSponsored(address indexed to, address indexed sponsor, uint256 amount);
    event ContractUnsponsored(address indexed to, address indexed sponsor, uint256 amount);
    event UserSponsored(address indexed from, address indexed sponsor, uint256 amount);
    event UserUnsponsored(address indexed from, address indexed sponsor, uint256 amount);
    event UserOperationSponsored(
        address indexed from,
        address indexed to,
        bytes4 operation,
        address indexed sponsor,
        uint256 amount
    );
    event UserOperationUnsponsored(
        address indexed from,
        address indexed to,
        bytes4 operation,
        address indexed sponsor,
        uint256 amount
    );

    error NotNode();
    error NotSponsored();
    error NothingToWithdraw();
    error TransferFailed();
    error NotAllowedInSponsoredTx();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract with an owner and enable upgradeability
    /// @param _owner Address to be set as owner of the contract
    function initialize(address _owner) external initializer {
        __Ownable_init(_owner);
        __UUPSUpgradeable_init();
    }

    /// @notice Sponsor calls of a specific user to a specific contract
    /// @param from The user address to be sponsored
    /// @param to The contract address to be sponsored
    function sponsorUserContract(address from, address to) public payable {
        _sponsor(userContractSponsorship[from][to], msg.sender, msg.value);
        emit UserContractSponsored(from, to, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user-contract sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param sponsor The sponsor address
    /// @return Withdrawable amount in wei
    function userContractWithdrawable(address from, address to, address sponsor) public view returns (uint256) {
        return _availableToWithdraw(userContractSponsorship[from][to], sponsor);
    }

    /// @notice Withdraw from a user-contract sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param amount Amount to withdraw in wei (capped to available)
    function unsponsorUserContract(address from, address to, uint256 amount) public {
        _withdraw(userContractSponsorship[from][to], msg.sender, amount);
        emit UserContractUnsponsored(from, to, msg.sender, amount);
    }

    /// @notice Sponsor a specific contract operation
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    function sponsorOperation(address to, bytes4 operation) public payable {
        _sponsor(operationSponsorship[to][operation], msg.sender, msg.value);
        emit OperationSponsored(to, operation, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from an operation sponsorship
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    /// @param sponsor The sponsor address
    /// @return Withdrawable amount in wei
    function operationWithdrawable(address to, bytes4 operation, address sponsor) public view returns (uint256) {
        return _availableToWithdraw(operationSponsorship[to][operation], sponsor);
    }

    /// @notice Withdraw from an operation sponsorship
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    /// @param amount Amount to withdraw in wei
    function unsponsorOperation(address to, bytes4 operation, uint256 amount) public {
        _withdraw(operationSponsorship[to][operation], msg.sender, amount);
        emit OperationUnsponsored(to, operation, msg.sender, amount);
    }

    /// @notice Sponsor a contract calls
    /// @param to The contract address to be sponsored
    function sponsorContract(address to) public payable {
        _sponsor(contractSponsorship[to], msg.sender, msg.value);
        emit ContractSponsored(to, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a contract sponsorship
    /// @param to The contract address
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function contractWithdrawable(address to, address sponsor) public view returns (uint256) {
        return _availableToWithdraw(contractSponsorship[to], sponsor);
    }

    /// @notice Withdraw from a contract sponsorship
    /// @param to The contract address
    /// @param amount Amount to withdraw in wei
    function unsponsorContract(address to, uint256 amount) public {
        _withdraw(contractSponsorship[to], msg.sender, amount);
        emit ContractUnsponsored(to, msg.sender, amount);
    }

    /// @notice Sponsor any transaction from a user
    /// @param from The user address to be sponsored
    function sponsorUser(address from) public payable {
        _sponsor(userSponsorship[from], msg.sender, msg.value);
        emit UserSponsored(from, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user sponsorship
    /// @param from User address
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function userWithdrawable(address from, address sponsor) public view returns (uint256) {
        return _availableToWithdraw(userSponsorship[from], sponsor);
    }

    /// @notice Withdraw from a user sponsorship
    /// @param from User address
    /// @param amount Amount to withdraw in wei
    function unsponsorUser(address from, uint256 amount) public {
        _withdraw(userSponsorship[from], msg.sender, amount);
        emit UserUnsponsored(from, msg.sender, amount);
    }

    /// @notice Sponsor calls of a specific operation (method) of a contract, sent from a specific user
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    function sponsorUserOperation(address from, address to, bytes4 operation) public payable {
        _sponsor(userOperationSponsorship[from][to][operation], msg.sender, msg.value);
        emit UserOperationSponsored(from, to, operation, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user's operation
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function userOperationWithdrawable(
        address from,
        address to,
        bytes4 operation,
        address sponsor
    ) public view returns (uint256) {
        return _availableToWithdraw(userOperationSponsorship[from][to][operation], sponsor);
    }

    /// @notice Withdraw sponsorship from a user's operation
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    /// @param amount Amount to withdraw in wei
    function unsponsorUserOperation(address from, address to, bytes4 operation, uint256 amount) public {
        _withdraw(userOperationSponsorship[from][to][operation], msg.sender, amount);
        emit UserOperationUnsponsored(from, to, operation, msg.sender, amount);
    }

    /// @notice Checks if a given fee can be covered by any available sponsorship
    /// @param from User address
    /// @param to Contract address
    /// @param data The calldata of the transaction
    /// @param fee Fee amount in wei
    /// @return True if fee is covered, false otherwise
    function isCovered(address from, address to, bytes calldata data, uint256 fee) public view returns (bool) {
        bytes4 operation = bytes4(data[0:4]);
        if (userContractSponsorship[from][to].available >= fee) return true;
        if (operationSponsorship[to][operation].available >= fee) return true;
        if (contractSponsorship[to].available >= fee) return true;
        if (userSponsorship[from].available >= fee) return true;
        if (userOperationSponsorship[from][to][operation].available >= fee) return true;
        return false;
    }

    /// @notice Deduct a fee from a sponsorship - to be called by the Sonic node.
    /// @param from User address
    /// @param to Contract address
    /// @param data The calldata of the transaction
    /// @param fee Fee amount in wei
    function deductFees(address from, address to, bytes calldata data, uint256 fee) public {
        require(msg.sender == address(0), NotNode());
        require(isCovered(from, to, data, fee), NotSponsored());

        SFC.burnNativeTokens{value: fee}();
        bytes4 operation = bytes4(data[0:4]);
        if (userContractSponsorship[from][to].available >= fee) {
            userContractSponsorship[from][to].available -= fee;
            return;
        }
        if (operationSponsorship[to][operation].available >= fee) {
            operationSponsorship[to][operation].available -= fee;
            return;
        }
        if (contractSponsorship[to].available >= fee) {
            contractSponsorship[to].available -= fee;
            return;
        }
        if (userSponsorship[from].available >= fee) {
            userSponsorship[from].available -= fee;
            return;
        }
        if (userOperationSponsorship[from][to][operation].available >= fee) {
            userOperationSponsorship[from][to][operation].available -= fee;
            return;
        }
    }

    /// @notice Get the contribution of a sponsor to a user-contract sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param contributor The sponsor address
    function getUserContractSponsorshipContribution(address from, address to, address contributor) public view returns (uint256) {
        return userContractSponsorship[from][to].contributors[contributor];
    }

    /// @notice Get the contribution of a sponsor to an operation sponsorship
    /// @param to The contract address being sponsored
    /// @param operation The 4-byte operation selector
    /// @param contributor The sponsor address
    function getOperationSponsorshipContribution(address to, bytes4 operation, address contributor) public view returns(uint256) {
        return operationSponsorship[to][operation].contributors[contributor];
    }

    /// @notice Get the contribution of a sponsor to a contract sponsorship
    /// @param to The contract address being sponsored
    /// @param contributor The sponsor address
    function getContractSponsorshipContribution(address to, address contributor) public view returns (uint256) {
        return contractSponsorship[to].contributors[contributor];
    }

    /// @notice Get the contribution of a sponsor to a user sponsorship
    /// @param from The user address being sponsored
    /// @param contributor The sponsor address
    function getUserSponsorshipContribution(address from, address contributor) public view returns (uint256) {
        return userSponsorship[from].contributors[contributor];
    }

    /// @notice Get the contribution of a sponsor to a user-operation sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param operation The 4-byte operation selector
    /// @param contributor The sponsor address
    function getUserOperationSponsorshipContribution(address from, address to, bytes4 operation, address contributor) public view returns (uint256) {
        return userOperationSponsorship[from][to][operation].contributors[contributor];
    }

    /// Override the upgrade authorization check to allow upgrades only from the owner.
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _sponsor(Sponsorship storage sponsorship, address sponsor, uint256 amount) private {
        sponsorship.available += amount;
        sponsorship.contributors[sponsor] += amount;
        sponsorship.totalContributions += amount;
    }

    function _availableToWithdraw(Sponsorship storage sponsorship, address sponsor) private view returns (uint256) {
        return (sponsorship.available * sponsorship.contributors[sponsor]) / sponsorship.totalContributions;
    }

    function _withdraw(Sponsorship storage sponsorship, address sponsor, uint256 amount) private {
        uint256 maxAmount = _availableToWithdraw(sponsorship, sponsor);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(tx.gasprice != 0, NotAllowedInSponsoredTx());

        sponsorship.available -= amount;
        sponsorship.totalContributions -= amount;
        sponsorship.contributors[sponsor] -= amount;

        (bool success, ) = sponsor.call{value: amount}("");
        require(success, TransferFailed());
    }
}
