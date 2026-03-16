// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ISFC} from "../interfaces/ISFC.sol";

/**
 * @title Liquid Staking Token for Sonic network
 * @notice Users deposit S tokens and receive LST tokens representing their staked position.
 *         LST value increases as staking rewards are restaked. Slashing decreases LST value.
 *         Redemption is always atomic: undelegate + withdraw happen in a single transaction,
 *         relying on the SFC supporting immediate withdrawals for this contract.
 *
 *         Small amounts are routed to/from a single validator; larger amounts are spread
 *         evenly across all whitelisted validators. Routing is based on total received stake
 *         (from all delegators) to keep validators similarly loaded.
 */
contract LiquidStakingToken is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    /// Below this threshold a single validator is used; above it, stake is spread evenly.
    uint256 public constant SMALL_STAKE_THRESHOLD = 1000 ether;
    /// Denominator for burn rate expressed in basis points (= 100%).
    uint256 public constant BURN_RATE_DENOMINATOR = 10000;

    ISFC public sfc;

    /// Burn rate in basis points applied to restaked rewards (e.g. 1000 = 10%).
    uint256 public burnRate;

    /// Ordered list of whitelisted validator IDs.
    uint256[] public validatorIds;
    mapping(uint256 validatorId => bool) public isWhitelisted;

    /// Global counter used to generate unique wrIds for SFC undelegation requests.
    uint256 public nextWrId;

    // ──────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────

    event Invested(address indexed user, uint256 sAmount, uint256 lstAmount);
    event Redeemed(address indexed user, uint256 lstAmount, uint256 sAmount);
    event Restaked(uint256 totalRewards, uint256 burned, uint256 restaked);
    event Rebalanced(uint256 indexed fromValidator, uint256 indexed toValidator, uint256 amount);
    event ValidatorAdded(uint256 indexed validatorId);
    event ValidatorRemoved(uint256 indexed validatorId);
    event BurnRateUpdated(uint256 newBurnRate);

    // ──────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────

    error NoValidators();
    error ValidatorAlreadyWhitelisted();
    error ValidatorNotWhitelisted();
    error InvalidBurnRate();
    error NotSfc();
    error ZeroAmount();
    error TransferFailed();
    error InsufficientStakeOnValidator();

    // ──────────────────────────────────────────────
    // Constructor & initializer
    // ──────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _sfc, address _owner, uint256 _burnRate) external initializer {
        if (_burnRate > BURN_RATE_DENOMINATOR) revert InvalidBurnRate();
        __ERC20_init("Liquid Staking Token", "LST");
        __Ownable_init(_owner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        sfc = ISFC(_sfc);
        burnRate = _burnRate;
    }

    // ──────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────

    /// @notice Whitelist a validator for staking.
    function addValidator(uint256 validatorId) external onlyOwner {
        if (isWhitelisted[validatorId]) revert ValidatorAlreadyWhitelisted();
        isWhitelisted[validatorId] = true;
        validatorIds.push(validatorId);
        emit ValidatorAdded(validatorId);
    }

    /// @notice Remove a validator from the whitelist.
    ///         Any existing stake on this validator remains; the protocol will stop
    ///         adding new stake to it.
    function removeValidator(uint256 validatorId) external onlyOwner {
        if (!isWhitelisted[validatorId]) revert ValidatorNotWhitelisted();
        isWhitelisted[validatorId] = false;
        uint256 n = validatorIds.length;
        for (uint256 i = 0; i < n; i++) {
            if (validatorIds[i] == validatorId) {
                validatorIds[i] = validatorIds[n - 1];
                validatorIds.pop();
                break;
            }
        }
        emit ValidatorRemoved(validatorId);
    }

    /// @notice Update the burn rate applied to restaking rewards.
    function setBurnRate(uint256 _burnRate) external onlyOwner {
        if (_burnRate > BURN_RATE_DENOMINATOR) revert InvalidBurnRate();
        burnRate = _burnRate;
        emit BurnRateUpdated(_burnRate);
    }

    // ──────────────────────────────────────────────
    // View helpers
    // ──────────────────────────────────────────────

    /// @notice Total S value backing all outstanding LST.
    ///         Includes stakes held in SFC and liquid S held by this contract.
    ///         Automatically reflects slashing because it reads live SFC stake values.
    ///         Does NOT include pending (unclaimed) rewards — those are booked in via restake().
    function totalLiquidStake() public view returns (uint256 total) {
        uint256 n = validatorIds.length;
        for (uint256 i = 0; i < n; i++) {
            total += sfc.getStake(address(this), validatorIds[i]);
        }
        total += address(this).balance;
    }

    /// @notice Convert an S amount to the equivalent LST at the current rate.
    function sToLst(uint256 sAmount) public view returns (uint256) {
        uint256 lstSupply = totalSupply();
        if (lstSupply == 0) return sAmount; // 1:1 on first deposit
        uint256 sSupply = totalLiquidStake();
        if (sSupply == 0) return sAmount;
        return (sAmount * lstSupply) / sSupply;
    }

    /// @notice Convert an LST amount to the equivalent S at the current rate.
    function lstToS(uint256 lstAmount) public view returns (uint256) {
        uint256 lstSupply = totalSupply();
        if (lstSupply == 0) return lstAmount; // 1:1 when no deposit exists
        uint256 sSupply = totalLiquidStake();
        return (lstAmount * sSupply) / lstSupply;
    }

    // ──────────────────────────────────────────────
    // Core operations
    // ──────────────────────────────────────────────

    /// @notice Deposit S tokens and receive LST representing the staked position.
    ///         The deposited S is delegated immediately to whitelisted validators.
    /// @return lstAmount Number of LST tokens minted.
    function invest() external payable nonReentrant returns (uint256 lstAmount) {
        if (msg.value == 0) revert ZeroAmount();
        if (validatorIds.length == 0) revert NoValidators();

        // Calculate LST before the new S is delegated so totalLiquidStake() does not
        // include msg.value yet (it's still in this.balance at this point).
        lstAmount = sToLst(msg.value);

        _delegateToValidators(msg.value);

        _mint(msg.sender, lstAmount);
        emit Invested(msg.sender, msg.value, lstAmount);
    }

    /// @notice Burn LST and atomically receive proportional S in the same transaction.
    function redeem(uint256 lstAmount) external nonReentrant {
        if (lstAmount == 0) revert ZeroAmount();

        uint256 sAmount = lstToS(lstAmount);

        // Burn LST first (Checks-Effects-Interactions).
        _burn(msg.sender, lstAmount);

        _undelegateFromValidators(sAmount);

        (bool sent,) = payable(msg.sender).call{value: sAmount}("");
        if (!sent) revert TransferFailed();

        emit Redeemed(msg.sender, lstAmount, sAmount);
    }

    /// @notice Claim accumulated staking rewards from all validators, apply the burn
    ///         rate, and re-delegate the remainder. Increases the LST/S conversion rate.
    ///         Anybody willing to pay gas for this can call it.
    function restake() external nonReentrant {
        uint256 n = validatorIds.length;
        for (uint256 i = 0; i < n; i++) {
            if (sfc.pendingRewards(address(this), validatorIds[i]) > 0) {
                sfc.claimRewards(validatorIds[i]);
            }
        }

        uint256 totalRewards = address(this).balance;
        if (totalRewards == 0) return;

        uint256 burned = (totalRewards * burnRate) / BURN_RATE_DENOMINATOR;
        uint256 toRestake = totalRewards - burned;

        if (burned > 0) {
            sfc.burnNativeTokens{value: burned}();
        }
        if (toRestake > 0) {
            _delegateToValidators(toRestake);
        }

        emit Restaked(totalRewards, burned, toRestake);
    }

    /// @notice Move a portion of our stake from the whitelisted validator with the highest
    ///         total received stake to the one with the lowest, narrowing the gap by half.
    ///         Can be called by anyone willing to pay the gas.
    function rebalance() external nonReentrant {
        uint256 n = validatorIds.length;
        if (n < 2) return;

        uint256 maxReceived = 0;
        uint256 minReceived = type(uint256).max;
        uint256 fromValidator = 0;
        uint256 toValidator = 0;

        for (uint256 i = 0; i < n; i++) {
            uint256 rs = _getValidatorReceivedStake(validatorIds[i]);
            if (rs > maxReceived && sfc.getStake(address(this), validatorIds[i]) > 0) {
                maxReceived = rs;
                fromValidator = validatorIds[i];
            }
            if (rs < minReceived) {
                minReceived = rs;
                toValidator = validatorIds[i];
            }
        }

        if (fromValidator == 0 || fromValidator == toValidator || maxReceived <= minReceived) return;

        uint256 ourStake = sfc.getStake(address(this), fromValidator);
        uint256 toMove = (maxReceived - minReceived) / 2;
        if (toMove > ourStake) toMove = ourStake;
        if (toMove == 0) return;

        uint256 wrId = nextWrId++;
        sfc.undelegate(fromValidator, wrId, toMove);
        sfc.withdraw(fromValidator, wrId);
        sfc.delegate{value: toMove}(toValidator);

        emit Rebalanced(fromValidator, toValidator, toMove);
    }

    // ──────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────

    /// @dev Returns the total received stake on a validator (from all delegators).
    function _getValidatorReceivedStake(uint256 validatorId) private view returns (uint256 receivedStake) {
        (, receivedStake,,,,,) = sfc.getValidator(validatorId);
    }

    /// @dev Small amounts go to the validator with the least total received stake.
    ///      Large amounts are split evenly across all whitelisted validators.
    function _delegateToValidators(uint256 amount) internal {
        uint256 n = validatorIds.length;
        if (n == 0) revert NoValidators();

        if (amount < SMALL_STAKE_THRESHOLD || n == 1) {
            uint256 minStake = type(uint256).max;
            uint256 minValidator = validatorIds[0];
            for (uint256 i = 0; i < n; i++) {
                uint256 rs = _getValidatorReceivedStake(validatorIds[i]);
                if (rs < minStake) {
                    minStake = rs;
                    minValidator = validatorIds[i];
                }
            }
            sfc.delegate{value: amount}(minValidator);
        } else {
            uint256 perValidator = amount / n;
            uint256 remainder = amount - perValidator * n;
            for (uint256 i = 0; i < n; i++) {
                sfc.delegate{value: perValidator + (i == 0 ? remainder : 0)}(validatorIds[i]);
            }
        }
    }

    /// @dev For small amounts tries to undelegate from a single validator; falls back to
    ///      even split if that validator does not have enough. Large amounts always split evenly.
    function _undelegateFromValidators(uint256 amount) internal {
        if (amount < SMALL_STAKE_THRESHOLD && validatorIds.length > 1) {
            // fast path for small amounts - try to use only one validator
            if (_undelegateFromSingleValidator(amount)) {
                return;
            }
        }
        // slow path for big amounts or when a single validator does not have enough
        _undelegateEvenly(amount);
    }

    /// @dev Undelegate `amount` from the single validator where we hold the most stake.
    ///      Returns false (without reverting) if that validator does not have enough stake.
    function _undelegateFromSingleValidator(uint256 amount) internal returns (bool) {
        uint256 n = validatorIds.length;
        uint256 maxStake = 0;
        uint256 maxValidator = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 s = sfc.getStake(address(this), validatorIds[i]);
            if (s > maxStake) {
                maxStake = s;
                maxValidator = validatorIds[i];
            }
        }
        if (maxStake < amount) return false;
        _undelegate(maxValidator, amount);
        return true;
    }

    /// @dev Undelegate `amount` evenly across all validators, capped at our stake on each.
    function _undelegateEvenly(uint256 amount) internal {
        uint256 n = validatorIds.length;
        uint256 perValidator = amount / n;
        uint256 remainder = amount - perValidator * n;
        uint256 remaining = amount;
        for (uint256 i = 0; i < n && remaining > 0; i++) {
            uint256 ourStake = sfc.getStake(address(this), validatorIds[i]);
            uint256 toWithdraw = perValidator + (i == 0 ? remainder : 0);
            if (toWithdraw > ourStake) toWithdraw = ourStake;
            if (toWithdraw == 0) continue;
            _undelegate(validatorIds[i], toWithdraw);
            remaining -= toWithdraw;
        }
        if (remaining > 0) revert InsufficientStakeOnValidator();
    }

    /// @dev Undelegate and immediately withdraw `amount` from a validator.
    function _undelegate(uint256 validatorId, uint256 amount) private {
        uint256 wrId = nextWrId++;
        sfc.undelegate(validatorId, wrId, amount);
        sfc.withdraw(validatorId, wrId);
    }

    /// @dev Only the owner can authorize an upgrade to a new implementation.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Accept S sent back by the SFC upon withdrawal.
    receive() external payable {
        if (msg.sender != address(sfc)) revert NotSfc();
    }
}
