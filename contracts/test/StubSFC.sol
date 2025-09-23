// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

contract StubSFC {
    address public immutable owner;

    event BurntNativeTokens(uint256 amount);

    constructor(address _owner) {
        owner = _owner;
    }

    function burnNativeTokens() external payable {
        emit BurntNativeTokens(msg.value);
    }
}
