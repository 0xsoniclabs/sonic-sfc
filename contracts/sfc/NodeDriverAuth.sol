// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ISFC} from "../interfaces/ISFC.sol";
import {NodeDriver} from "./NodeDriver.sol";

/**
 * @custom:security-contact security@fantom.foundation
 */
contract NodeDriverAuth is OwnableUpgradeable, UUPSUpgradeable {
    address private constant frozenAccountImpl = 0xCdC13932990fDBC8e4397AF1BFd0762D7E6d71bA;

    ISFC internal sfc;
    NodeDriver internal driver;

    error NotSFC();
    error NotDriver();
    error UpgradesDisabled();
    error NotExternalAccount();
    error NotFrozenAccount();

    event FrozenAccount(address account, string reason);
    event UnfrozenAccount(address account, string reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Initialize NodeDriverAuth, NodeDriver and SFC in one call to allow fewer genesis transactions
    function initialize(address payable _sfc, address _driver, address _owner) external initializer {
        __Ownable_init(_owner);
        __UUPSUpgradeable_init();
        driver = NodeDriver(_driver);
        sfc = ISFC(_sfc);
    }

    /// Override the upgrade authorization check to disable upgrades.
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal view override onlyOwner {
        revert UpgradesDisabled();
    }

    /// Callable only by SFC contract.
    modifier onlySFC() {
        if (msg.sender != address(sfc)) {
            revert NotSFC();
        }
        _;
    }

    /// Callable only by NodeDriver (mediates messages from the network client)
    modifier onlyDriver() {
        if (msg.sender != address(driver)) {
            revert NotDriver();
        }
        _;
    }

    /// Mint native token. To be used by SFC for minting validators rewards.
    function incBalance(address acc, uint256 diff) external onlySFC {
        driver.setBalance(acc, acc.balance + diff);
    }

    /// Increment nonce of the given account.
    function incNonce(address acc, uint256 diff) external onlyOwner {
        driver.incNonce(acc, diff);
    }

    /// Update network rules by providing a JSON patch.
    function updateNetworkRules(bytes calldata diff) external onlyOwner {
        driver.updateNetworkRules(diff);
    }

    /// Update advertised network version.
    function updateNetworkVersion(uint256 version) external onlyOwner {
        driver.updateNetworkVersion(version);
    }

    /// Freeze account.
    function freezeAccount(address toFreeze, string memory reason) external onlyOwner {
        if (!isExternalAccount(toFreeze) || toFreeze == address(0)) {
            revert NotExternalAccount();
        }
        driver.copyCode(toFreeze, frozenAccountImpl);
        emit FrozenAccount(toFreeze, reason);
    }

    /// Unfreeze account.
    function unfreezeAccount(address toUnfreeze, string memory reason) external onlyOwner {
        if (toUnfreeze.codehash != frozenAccountImpl.codehash) {
            revert NotFrozenAccount();
        }
        driver.copyCode(toUnfreeze, address(0));
        emit UnfrozenAccount(toUnfreeze, reason);
    }

    /// Enforce sealing given number of epochs.
    function advanceEpochs(uint256 num) external onlyOwner {
        driver.advanceEpochs(num);
    }

    /// Update weight of a validator. Used to propagate a stake change from SFC to the client.
    function updateValidatorWeight(uint256 validatorID, uint256 value) external onlySFC {
        driver.updateValidatorWeight(validatorID, value);
    }

    /// Update public key of a validator. Used to propagate a change from SFC to the client.
    function updateValidatorPubkey(uint256 validatorID, bytes calldata pubkey) external onlySFC {
        driver.updateValidatorPubkey(validatorID, pubkey);
    }

    /// Set an initial validator into SFC. Called only as part of network initialization/genesis file generating.
    function setGenesisValidator(
        address auth,
        uint256 validatorID,
        bytes calldata pubkey,
        uint256 createdTime
    ) external onlyDriver {
        sfc.setGenesisValidator(auth, validatorID, pubkey, createdTime);
    }

    /// Set an initial delegation. Called only as part of network initialization/genesis file generating.
    function setGenesisDelegation(address delegator, uint256 toValidatorID, uint256 stake) external onlyDriver {
        sfc.setGenesisDelegation(delegator, toValidatorID, stake);
    }

    /// Deactivate a validator. Called by network node when a double-sign of the given validator is registered.
    /// Is called before sealEpoch() call.
    function deactivateValidator(uint256 validatorID, uint256 status) external onlyDriver {
        sfc.deactivateValidator(validatorID, status);
    }

    /// Seal epoch. Called BEFORE epoch sealing made by the client itself.
    function sealEpoch(
        uint256[] calldata offlineTimes,
        uint256[] calldata offlineBlocks,
        uint256[] calldata uptimes,
        uint256[] calldata originatedTxsFee
    ) external onlyDriver {
        sfc.sealEpoch(offlineTimes, offlineBlocks, uptimes, originatedTxsFee);
    }

    /// Seal epoch. Called AFTER epoch sealing made by the client itself.
    function sealEpochValidators(uint256[] calldata nextValidatorIDs) external onlyDriver {
        sfc.sealEpochValidators(nextValidatorIDs);
    }

    /// Check the account is an EOA - it has no code or it has an EIP-7702 delegation
    function isExternalAccount(address account) private returns (bool) {
        bytes memory code = account.code;
        return code.length == 0 || (code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
    }

    uint256[50] private __gap;
}
