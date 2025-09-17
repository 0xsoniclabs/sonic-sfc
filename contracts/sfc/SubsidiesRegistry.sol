// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ISFC} from "../interfaces/ISFC.sol";

contract SubsidiesRegistry {

    ISFC private constant sfc = ISFC(0xFC00FACE00000000000000000000000000000000);

    // Policy 1: From -> To -> Deposit Amount
    mapping(address from => mapping(address to => uint256 amount)) public userSponsorships;
    mapping(address from => mapping(address to => uint256 amount)) public userSponsorshipsTotal;
    mapping(address from => mapping(address to => mapping(address sponsor => uint256 amount))) public userSponsorshipsPerSponsor;

    // Policy 2: To -> Operation Hash -> Deposit Amount
    mapping(address to => mapping(bytes32 operation => uint256 amount)) public operationSponsorships;
    mapping(address to => mapping(bytes32 operation => uint256 amount)) public operationSponsorshipsTotal;
    mapping(address from => mapping(bytes32 operation => mapping(address sponsor => uint256 amount))) public operationSponsorshipsPerSponsor;

    // Policy 3: To -> Deposit Amount
    mapping(address to => uint256 amount) public contractSponsorships;
    mapping(address to => uint256 amount) public contractSponsorshipsTotal;
    mapping(address to => mapping(address sponsor => uint256 amount)) public contractSponsorshipsPerSponsor;

    error NotNode();
    error NotSponsored();
    error NothingToWithdraw();

    function sponsorUser(address from, address to) public payable {
        userSponsorships[from][to] += msg.value;
        userSponsorshipsTotal[from][to] += msg.value;
        userSponsorshipsPerSponsor[from][to][msg.sender] += msg.value;
    }

    function sponsorOperation(address to, bytes32 operation) public payable {
        operationSponsorships[to][operation] += msg.value;
        operationSponsorshipsTotal[to][operation] += msg.value;
        operationSponsorshipsPerSponsor[to][operation][msg.sender] += msg.value;
    }

    function sponsorContract(address to) public payable {
        contractSponsorships[to] += msg.value;
        contractSponsorshipsTotal[to] += msg.value;
        contractSponsorshipsPerSponsor[to][msg.sender] += msg.value;
    }

    function userSponsorshipWithdrawable(address from, address to, address sponsor) public view returns(uint256) {
        return userSponsorships[from][to] * userSponsorshipsPerSponsor[from][to][sponsor] / userSponsorshipsTotal[from][to];
    }

    function operationSponsorshipWithdrawable(address to, bytes32 operation, address sponsor) public view returns(uint256) {
        return operationSponsorships[to][operation] * operationSponsorshipsPerSponsor[to][operation][sponsor] / operationSponsorshipsTotal[to][operation];
    }

    function contractSponsorshipWithdrawable(address to, address sponsor) public view returns(uint256) {
        return contractSponsorships[to] * contractSponsorshipsPerSponsor[to][sponsor] / contractSponsorshipsTotal[to];
    }

    function unsponsorUser(address from, address to, uint256 amount) public {
        uint256 maxAmount = userSponsorshipWithdrawable(from, to, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        userSponsorships[from][to] -= amount;
        userSponsorshipsTotal[from][to] -= amount;
        userSponsorshipsPerSponsor[from][to][msg.sender] -= amount;
    }

    function unsponsorOperation(address to, bytes32 operation, uint256 amount) public {
        uint256 maxAmount = operationSponsorshipWithdrawable(to, operation, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        operationSponsorships[to][operation] -= amount;
        operationSponsorshipsTotal[to][operation] -= amount;
        operationSponsorshipsPerSponsor[to][operation][msg.sender] -= amount;
    }

    function unsponsorContract(address to, uint256 amount) public {
        uint256 maxAmount = contractSponsorshipWithdrawable(to, msg.sender);
        if (amount > maxAmount) {
            amount = maxAmount;
        }
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        contractSponsorships[to] -= amount;
        contractSponsorshipsTotal[to] -= amount;
        contractSponsorshipsPerSponsor[to][msg.sender] -= amount;
    }

    function isCovered(address from, address to, bytes32 operationHash, uint256 fee) public view returns(bool) {
        if(userSponsorships[from][to] >= fee){
            return true;
        }
        if(operationSponsorships[to][operationHash] >= fee){
            return true;
        }
        if(contractSponsorships[to] >= fee){
            return true;
        }
        return false;
    }

    function deductFees(address from, address to, bytes32 operationHash, uint256 fee) public {
        if (msg.sender != address(0)) {
            revert NotNode();
        }
        if (!isCovered(from, to, operationHash, fee)) {
            revert NotSponsored();
        }

        sfc.burnNativeTokens{value: fee}();
        if (userSponsorships[from][to] >= fee) {
            userSponsorships[from][to] -= fee;
            return;
        }
        if (operationSponsorships[to][operationHash] >= fee) {
            operationSponsorships[to][operationHash] -= fee;
            return;
        }
        if (contractSponsorships[to] >= fee) {
            contractSponsorships[to] -= fee;
            return;
        }
    }

    // TODO: define policies for the following features
    // - Withdraw sponsorships
    // - Additional allocation policies
    // - Access order of sponsorship policies
    // - Admin functions
    // - Events
}
