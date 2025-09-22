// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ISFC} from "../interfaces/ISFC.sol";

contract SubsidiesRegistry is OwnableUpgradeable, UUPSUpgradeable {

    ISFC private constant sfc = ISFC(0xFC00FACE00000000000000000000000000000000);

    // User-Contract sponsorship: From -> To -> Deposit Amount
    mapping(address from => mapping(address to => uint256 amount)) public userContractAvailable;
    mapping(address from => mapping(address to => uint256 amount)) public userContractTotal;
    mapping(address from => mapping(address to => mapping(address sponsor => uint256 amount))) public userContractSponsor;

    // Operation sponsorship: To -> Operation Signature -> Deposit Amount
    mapping(address to => mapping(bytes4 operation => uint256 amount)) public operationAvailable;
    mapping(address to => mapping(bytes4 operation => uint256 amount)) public operationTotal;
    mapping(address to => mapping(bytes4 operation => mapping(address sponsor => uint256 amount))) public operationSponsor;

    // Contract sponsorship: To -> Deposit Amount
    mapping(address to => uint256 amount) public contractAvailable;
    mapping(address to => uint256 amount) public contractTotal;
    mapping(address to => mapping(address sponsor => uint256 amount)) public contractSponsor;

    // User sponsorship: From -> Deposit Amount
    mapping(address from => uint256 amount) public userAvailable;
    mapping(address from => uint256 amount) public userTotal;
    mapping(address from => mapping(address sponsor => uint256 amount)) public userSponsor;

    // User-Operation sponsorship: From -> To -> Operation Signature -> Deposit Amount
    mapping(address from => mapping(address to => mapping(bytes4 operation => uint256 amount))) public userOperationAvailable;
    mapping(address from => mapping(address to => mapping(bytes4 operation => uint256 amount))) public userOperationTotal;
    mapping(address from => mapping(address to => mapping(bytes4 operation => mapping(address sponsor => uint256 amount)))) public userOperationSponsor;

    event UserContractSponsored(address indexed from, address indexed to, address indexed sponsor, uint256 amount);
    event UserContractUnsponsored(address indexed from, address indexed to, address indexed sponsor, uint256 amount);
    event OperationSponsored(address indexed to, bytes4 indexed operation, address indexed sponsor, uint256 amount);
    event OperationUnsponsored(address indexed to, bytes4 indexed operation, address indexed sponsor, uint256 amount);
    event ContractSponsored(address indexed to, address indexed sponsor, uint256 amount);
    event ContractUnsponsored(address indexed to, address indexed sponsor, uint256 amount);
    event UserSponsored(address indexed from, address indexed sponsor, uint256 amount);
    event UserUnsponsored(address indexed from, address indexed sponsor, uint256 amount);
    event UserOperationSponsored(address indexed from, address indexed to, bytes4 operation, address indexed sponsor, uint256 amount);
    event UserOperationUnsponsored(address indexed from, address indexed to, bytes4 operation, address indexed sponsor, uint256 amount);

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
        userContractAvailable[from][to] += msg.value;
        userContractTotal[from][to] += msg.value;
        userContractSponsor[from][to][msg.sender] += msg.value;
        emit UserContractSponsored(from, to, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user-contract sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param sponsor The sponsor address
    /// @return Withdrawable amount in wei
    function userContractWithdrawable(address from, address to, address sponsor) public view returns(uint256) {
        return userContractAvailable[from][to] * userContractSponsor[from][to][sponsor] / userContractTotal[from][to];
    }

    /// @notice Withdraw from a user-contract sponsorship
    /// @param from The user address being sponsored
    /// @param to The contract address being sponsored
    /// @param amount Amount to withdraw in wei (capped to available)
    function unsponsorUserContract(address from, address to, uint256 amount) public {
        uint256 maxAmount = userContractWithdrawable(from, to, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(notInSponsoredTx(), NotAllowedInSponsoredTx());

        userContractAvailable[from][to] -= amount;
        userContractTotal[from][to] -= amount;
        userContractSponsor[from][to][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserContractUnsponsored(from, to, msg.sender, amount);
    }

    /// @notice Sponsor a specific contract operation
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    function sponsorOperation(address to, bytes4 operation) public payable {
        operationAvailable[to][operation] += msg.value;
        operationTotal[to][operation] += msg.value;
        operationSponsor[to][operation][msg.sender] += msg.value;
        emit OperationSponsored(to, operation, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from an operation sponsorship
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    /// @param sponsor The sponsor address
    /// @return Withdrawable amount in wei
    function operationWithdrawable(address to, bytes4 operation, address sponsor) public view returns(uint256) {
        return operationAvailable[to][operation] * operationSponsor[to][operation][sponsor] / operationTotal[to][operation];
    }

    /// @notice Withdraw from an operation sponsorship
    /// @param to The contract address
    /// @param operation The 4-byte operation selector
    /// @param amount Amount to withdraw in wei
    function unsponsorOperation(address to, bytes4 operation, uint256 amount) public {
        uint256 maxAmount = operationWithdrawable(to, operation, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(notInSponsoredTx(), NotAllowedInSponsoredTx());

        operationAvailable[to][operation] -= amount;
        operationTotal[to][operation] -= amount;
        operationSponsor[to][operation][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit OperationUnsponsored(to, operation, msg.sender, amount);
    }

    /// @notice Sponsor a contract calls
    /// @param to The contract address to be sponsored
    function sponsorContract(address to) public payable {
        contractAvailable[to] += msg.value;
        contractTotal[to] += msg.value;
        contractSponsor[to][msg.sender] += msg.value;
        emit ContractSponsored(to, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a contract sponsorship
    /// @param to The contract address
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function contractWithdrawable(address to, address sponsor) public view returns(uint256) {
        return contractAvailable[to] * contractSponsor[to][sponsor] / contractTotal[to];
    }

    /// @notice Withdraw from a contract sponsorship
    /// @param to The contract address
    /// @param amount Amount to withdraw in wei
    function unsponsorContract(address to, uint256 amount) public {
        uint256 maxAmount = contractWithdrawable(to, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(notInSponsoredTx(), NotAllowedInSponsoredTx());

        contractAvailable[to] -= amount;
        contractTotal[to] -= amount;
        contractSponsor[to][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit ContractUnsponsored(to, msg.sender, amount);
    }

    /// @notice Sponsor any transaction from a user
    /// @param from The user address to be sponsored
    function sponsorUser(address from) public payable {
        userAvailable[from] += msg.value;
        userTotal[from] += msg.value;
        userSponsor[from][msg.sender] += msg.value;
        emit UserSponsored(from, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user sponsorship
    /// @param from User address
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function userWithdrawable(address from, address sponsor) public view returns(uint256) {
        return userAvailable[from] * userSponsor[from][sponsor] / userTotal[from];
    }

    /// @notice Withdraw from a user sponsorship
    /// @param from User address
    /// @param amount Amount to withdraw in wei
    function unsponsorUser(address from, uint256 amount) public {
        uint256 maxAmount = userWithdrawable(from, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(notInSponsoredTx(), NotAllowedInSponsoredTx());

        userAvailable[from] -= amount;
        userTotal[from] -= amount;
        userSponsor[from][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserUnsponsored(from, msg.sender, amount);
    }

    /// @notice Sponsor calls of a specific operation (method) of a contract, sent from a specific user
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    function sponsorUserOperation(address from, address to, bytes4 operation) public payable {
        userOperationAvailable[from][to][operation] += msg.value;
        userOperationTotal[from][to][operation] += msg.value;
        userOperationSponsor[from][to][operation][msg.sender] += msg.value;
        emit UserOperationSponsored(from, to, operation, msg.sender, msg.value);
    }

    /// @notice Returns how much a sponsor can withdraw from a user's operation
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    /// @param sponsor Sponsor address
    /// @return Withdrawable amount in wei
    function userOperationWithdrawable(address from, address to, bytes4 operation, address sponsor) public view returns(uint256) {
        return userOperationAvailable[from][to][operation] * userOperationSponsor[from][to][operation][sponsor] / userOperationTotal[from][to][operation];
    }

    /// @notice Withdraw sponsorship from a user's operation
    /// @param from User address
    /// @param to Contract address
    /// @param operation 4-byte operation selector
    /// @param amount Amount to withdraw in wei
    function unsponsorUserOperation(address from, address to, bytes4 operation, uint256 amount) public {
        uint256 maxAmount = userOperationWithdrawable(from, to, operation, msg.sender);
        if (amount > maxAmount) amount = maxAmount;
        require(amount != 0, NothingToWithdraw());
        require(notInSponsoredTx(), NotAllowedInSponsoredTx());

        userOperationAvailable[from][to][operation] -= amount;
        userOperationTotal[from][to][operation] -= amount;
        userOperationSponsor[from][to][operation][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserOperationUnsponsored(from, to, operation, msg.sender, amount);
    }

    /// @notice Checks if a given fee can be covered by any available sponsorship
    /// @param from User address
    /// @param to Contract address
    /// @param data The calldata of the transaction
    /// @param fee Fee amount in wei
    /// @return True if fee is covered, false otherwise
    function isCovered(address from, address to, bytes calldata data, uint256 fee) public view returns(bool) {
        if (userContractAvailable[from][to] >= fee) return true;
        bytes4 operation = bytes4(data[0:4]);
        if (operationAvailable[to][operation] >= fee) return true;
        if (contractAvailable[to] >= fee) return true;
        if (userAvailable[from] >= fee) return true;
        if (userOperationAvailable[from][to][operation] >= fee) return true;
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

        sfc.burnNativeTokens{value: fee}();
        if (userContractAvailable[from][to] >= fee) {
            userContractAvailable[from][to] -= fee;
            return;
        }
        bytes4 operation = bytes4(data[0:4]);
        if (operationAvailable[to][operation] >= fee) {
            operationAvailable[to][operation] -= fee;
            return;
        }
        if (contractAvailable[to] >= fee) {
            contractAvailable[to] -= fee;
            return;
        }
        if (userAvailable[from] >= fee) {
            userAvailable[from] -= fee;
            return;
        }
        if (userOperationAvailable[from][to][operation] >= fee) {
            userOperationAvailable[from][to][operation] -= fee;
            return;
        }
    }

    /// Override the upgrade authorization check to allow upgrades only from the owner.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function notInSponsoredTx() private view returns (bool) {
        return tx.gasprice != 0;
    }

}
