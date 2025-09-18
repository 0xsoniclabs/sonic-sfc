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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// Initialization is called only once, after the contract deployment.
    function initialize(address _owner) external initializer {
        __Ownable_init(_owner);
        __UUPSUpgradeable_init();
    }

    /// @notice Sponsor calls of a user to a contract
    function sponsorUserContract(address from, address to) public payable {
        userContractAvailable[from][to] += msg.value;
        userContractTotal[from][to] += msg.value;
        userContractSponsor[from][to][msg.sender] += msg.value;
        emit UserContractSponsored(from, to, msg.sender, msg.value);
    }

    function userContractWithdrawable(address from, address to, address sponsor) public view returns(uint256) {
        return userContractAvailable[from][to] * userContractSponsor[from][to][sponsor] / userContractTotal[from][to];
    }

    function unsponsorUserContract(address from, address to, uint256 amount) public {
        uint256 maxAmount = userContractWithdrawable(from, to, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        userContractAvailable[from][to] -= amount;
        userContractTotal[from][to] -= amount;
        userContractSponsor[from][to][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserContractUnsponsored(from, to, msg.sender, amount);
    }

    /// @notice Sponsor calls of a method of a contract
    function sponsorOperation(address to, bytes4 operation) public payable {
        operationAvailable[to][operation] += msg.value;
        operationTotal[to][operation] += msg.value;
        operationSponsor[to][operation][msg.sender] += msg.value;
        emit OperationSponsored(to, operation, msg.sender, msg.value);
    }

    function operationWithdrawable(address to, bytes4 operation, address sponsor) public view returns(uint256) {
        return operationAvailable[to][operation] * operationSponsor[to][operation][sponsor] / operationTotal[to][operation];
    }

    function unsponsorOperation(address to, bytes4 operation, uint256 amount) public {
        uint256 maxAmount = operationWithdrawable(to, operation, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        operationAvailable[to][operation] -= amount;
        operationTotal[to][operation] -= amount;
        operationSponsor[to][operation][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit OperationUnsponsored(to, operation, msg.sender, amount);
    }

    /// @notice Sponsor calls of a contract
    function sponsorContract(address to) public payable {
        contractAvailable[to] += msg.value;
        contractTotal[to] += msg.value;
        contractSponsor[to][msg.sender] += msg.value;
        emit ContractSponsored(to, msg.sender, msg.value);
    }

    function contractWithdrawable(address to, address sponsor) public view returns(uint256) {
        return contractAvailable[to] * contractSponsor[to][sponsor] / contractTotal[to];
    }

    function unsponsorContract(address to, uint256 amount) public {
        uint256 maxAmount = contractWithdrawable(to, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        contractAvailable[to] -= amount;
        contractTotal[to] -= amount;
        contractSponsor[to][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit ContractUnsponsored(to, msg.sender, amount);
    }

    /// @notice Sponsor calls of the given sender
    function sponsorUser(address from) public payable {
        userAvailable[from] += msg.value;
        userTotal[from] += msg.value;
        userSponsor[from][msg.sender] += msg.value;
        emit UserSponsored(from, msg.sender, msg.value);
    }

    function userWithdrawable(address from, address sponsor) public view returns(uint256) {
        return userAvailable[from] * userSponsor[from][sponsor] / userTotal[from];
    }

    function unsponsorUser(address from, uint256 amount) public {
        uint256 maxAmount = userWithdrawable(from, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        userAvailable[from] -= amount;
        userTotal[from] -= amount;
        userSponsor[from][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserUnsponsored(from, msg.sender, amount);
    }

    /// @notice Sponsor calls of a user to a method of a contract
    function sponsorUserOperation(address from, address to, bytes4 operation) public payable {
        userOperationAvailable[from][to][operation] += msg.value;
        userOperationTotal[from][to][operation] += msg.value;
        userOperationSponsor[from][to][operation][msg.sender] += msg.value;
        emit UserOperationSponsored(from, to, operation, msg.sender, msg.value);
    }

    function userOperationWithdrawable(address from, address to, bytes4 operation, address sponsor) public view returns(uint256) {
        return userOperationAvailable[from][to][operation] * userOperationSponsor[from][to][operation][sponsor] / userOperationTotal[from][to][operation];
    }

    function unsponsorUserOperation(address from, address to, bytes4 operation, uint256 amount) public {
        uint256 maxAmount = userOperationWithdrawable(from, to, operation, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        userOperationAvailable[from][to][operation] -= amount;
        userOperationTotal[from][to][operation] -= amount;
        userOperationSponsor[from][to][operation][msg.sender] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, TransferFailed());

        emit UserOperationUnsponsored(from, to, operation, msg.sender, amount);
    }

    function isCovered(address from, address to, bytes4 operation, uint256 fee) public view returns(bool) {
        if (userContractAvailable[from][to] >= fee) {
            return true;
        }
        if (operationAvailable[to][operation] >= fee) {
            return true;
        }
        if (contractAvailable[to] >= fee) {
            return true;
        }
        if (userAvailable[from] >= fee) {
            return true;
        }
        if (userOperationAvailable[from][to][operation] >= fee) {
            return true;
        }
        return false;
    }

    function deductFees(address from, address to, bytes4 operation, uint256 fee) public {
        require(msg.sender == address(0), NotNode());
        require(isCovered(from, to, operation, fee), NotSponsored());

        sfc.burnNativeTokens{value: fee}();
        if (userContractAvailable[from][to] >= fee) {
            userContractAvailable[from][to] -= fee;
            return;
        }
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
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}

}
