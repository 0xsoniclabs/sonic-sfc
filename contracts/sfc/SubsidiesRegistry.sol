// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ISFC} from "../interfaces/ISFC.sol";

contract SubsidiesRegistry {

    ISFC private constant sfc = ISFC(0xFC00FACE00000000000000000000000000000000);

    // Policy 1: From -> To -> Deposit Amount
    mapping(address from => mapping(address to => uint256 amount)) public userSponsorships;

    // Policy 2: To -> Operation Hash -> Deposit Amount
    mapping(address to => mapping(bytes32 operation => uint256 amount)) public operationSponsorships;

    // Policy 3: To -> Deposit Amount
    mapping(address to => uint256 amount) public contractSponsorships;

    error NotNode();
    error NotSponsored();

    function sponsorUser(address from, address to) public payable {
        userSponsorships[from][to] += msg.value;
    }

    function sponsorMethod(address to, bytes32 operationHash) public payable {
        operationSponsorships[to][operationHash] += msg.value;
    }

    function sponsorContract(address to) public payable {
        contractSponsorships[to] += msg.value;
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
