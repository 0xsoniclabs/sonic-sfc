// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IPriorityRegistry} from "../interfaces/IPriorityRegistry.sol";
import {ISFC} from "../interfaces/ISFC.sol";
import {Version} from "../version/Version.sol";

/**
 * @title Priority Registry
 * @notice Registry managing transactions prioritization on the Sonic chain.
 * @dev Transactions are prioritized by sender, and the node enforces per-entity rate limits.
 *
 * For each transaction the node queries `getPriority`, which returns a (level, weight, id) triple:
 *   - level:  0 = no priority; > 0 = prioritized (higher level scheduled first).
 *   - weight: tie-breaker within a level (higher first).
 *   - id:     entity identifier used for per-entity rate limiting.
 *
 * `getPriorityConfig` returns the per-entity rate limits enforced by the node
 * during block formation and event emission.
 *
 * The registry is governed and upgradeable behind a proxy.
 * The node depends only on the IPriorityRegistry interface ABI.
 * @custom:security-contact security@fantom.foundation
 */
contract PriorityRegistry is
    IPriorityRegistry,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    Version
{
    /**
     * @notice Priority assigned to transactions of an entity.
     * @dev Storage layout for the `(level, weight, id)` triple returned by `getPriority`.
     */
    struct Priority {
        /** @notice 0 = no priority; > 0 = prioritized (higher level scheduled first). */
        uint64 level;
        /** @notice Tie-breaker within a level (higher first). */
        uint64 weight;
        /** @notice Entity identifier used for per-entity rate limiting. */
        uint128 id;
    }

    ISFC private constant SFC = ISFC(0xFC00FACE00000000000000000000000000000000);

    /** @notice Role allowed to configure sender priorities and rate limits. */
    bytes32 public constant PRIORITY_MANAGER_ROLE = keccak256("PRIORITY_MANAGER_ROLE");

    /** @notice Role allowed to configure system-wide configuration. */
    bytes32 public constant CONFIGURATOR_ROLE = keccak256("CONFIGURATOR_ROLE");

    /** @notice Role allowed to pause and unpause the registry. */
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /** @notice Priority assigned to transactions by sender. */
    mapping(address => Priority) public senderPriority;

    /** @notice Maximum gas limit for a transaction to be prioritized. Zero disables the gas filter. */
    uint256 public maxGasPerTx;

    /** @notice Per-entity total gas budget within a single block. Zero selects `DEFAULT_MAX_GAS_PER_BLOCK`. */
    uint256 public maxGasPerEntityPerBlock;

    /** @notice Per-entity cap on foreign piggybacked transactions per event. Zero selects `DEFAULT_MAX_PIGGYBACK_PER_EVENT`. */
    uint256 public maxPiggybackTxsPerEntityPerEvent;

    /** @notice Default value of `maxGasPerEntityPerBlockValue` when it is unset. */
    uint256 public constant DEFAULT_MAX_GAS_PER_BLOCK = 10_000_000;

    /** @notice Default value of `maxPiggybackTxsPerEntityPerEventValue` when it is unset. */
    uint256 public constant DEFAULT_MAX_PIGGYBACK_PER_EVENT = 4;

    /** @notice Emitted when a sender's priority is set. */
    event SenderPrioritySet(address indexed sender, uint64 level, uint64 weight, uint128 entityId);

    /** @notice Emitted when the maximum gas limit for a transaction to be prioritized is changed. */
    event MaxGasPerTxSet(uint256 newMaxGasPerTx);

    /** @notice Emitted when the per-entity per-block gas budget is changed. */
    event MaxGasPerEntityPerBlockSet(uint256 newMaxGasPerEntityPerBlock);

    /** @notice Emitted when the per-entity per-event piggyback cap is changed. */
    event MaxPiggybackTxsPerEntityPerEventSet(uint256 newMaxPiggybackTxsPerEntityPerEvent);

    /** @custom:oz-upgrades-unsafe-allow constructor */
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract with an admin from SFC and enable upgradability.
     */
    function initialize() external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, SFC.owner());
    }

    /**
     * @notice Set the priority of a sender.
     * @param sender Sender to assign the priority to.
     * @param level Priority level: 0 = no priority; > 0 = prioritized, higher levels go first.
     * @param weight Tie-breaker within a level - higher weights go first.
     * @param entityId Entity identifier; transactions sharing an id are rate-limited together.
     */
    function setSenderPriority(
        address sender,
        uint64 level,
        uint64 weight,
        uint128 entityId
    ) external onlyRole(PRIORITY_MANAGER_ROLE) {
        senderPriority[sender] = Priority(level, weight, entityId);
        emit SenderPrioritySet(sender, level, weight, entityId);
    }

    /**
     * @notice Set the maximum gas limit for a transaction to be prioritized. Zero disables this filter.
     * @param newMaxGasPerTx New maximum gas limit.
     */
    function setMaxGasPerTx(uint256 newMaxGasPerTx) external onlyRole(CONFIGURATOR_ROLE) {
        maxGasPerTx = newMaxGasPerTx;
        emit MaxGasPerTxSet(newMaxGasPerTx);
    }

    /**
     * @notice Set the per-entity rate limits enforced by the node.
     * @param perBlockGas New maximal gas per entity and block.
     */
    function setMaxGasPerEntityPerBlock(uint256 perBlockGas) external onlyRole(CONFIGURATOR_ROLE) {
        maxGasPerEntityPerBlock = perBlockGas;
        emit MaxGasPerEntityPerBlockSet(perBlockGas);
    }

    /**
     * @notice Set the per-entity cap on foreign piggybacked transactions.
     * @param perEventPiggybacks New per-entity cap on foreign piggybacked transactions.
     */
    function setMaxPiggybackTxsPerEntityPerEvent(uint256 perEventPiggybacks) external onlyRole(CONFIGURATOR_ROLE) {
        maxPiggybackTxsPerEntityPerEvent = perEventPiggybacks;
        emit MaxPiggybackTxsPerEntityPerEventSet(perEventPiggybacks);
    }

    /**
     * @inheritdoc IPriorityRegistry
     */
    function getPriority(
        address from,
        address /*to*/,
        uint256 /*value*/,
        uint256 /*nonce*/,
        bytes calldata /*callData*/,
        uint256 gasLimit
    ) external view returns (uint64 level, uint64 weight, uint128 id) {
        if (paused()) {
            return (0, 0, 0); // paused, no priority for anyone
        }
        uint256 gasLimitCap = maxGasPerTx;
        if (gasLimitCap != 0 && gasLimit > gasLimitCap) {
            return (0, 0, 0); // limit exceeded, no priority
        }
        Priority storage p = senderPriority[from];
        return (p.level, p.weight, p.id);
    }

    /**
     * @inheritdoc IPriorityRegistry
     */
    function getPriorityConfig()
        external
        view
        returns (uint256 _maxGasPerEntityPerBlock, uint256 _maxPiggybackTxsPerEntityPerEvent)
    {
        _maxGasPerEntityPerBlock = maxGasPerEntityPerBlock;
        if (_maxGasPerEntityPerBlock == 0) {
            _maxGasPerEntityPerBlock = DEFAULT_MAX_GAS_PER_BLOCK;
        }

        _maxPiggybackTxsPerEntityPerEvent = maxPiggybackTxsPerEntityPerEvent;
        if (_maxPiggybackTxsPerEntityPerEvent == 0) {
            _maxPiggybackTxsPerEntityPerEvent = DEFAULT_MAX_PIGGYBACK_PER_EVENT;
        }
    }

    /** @notice Pause the transactions prioritization. */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /** @notice Unpause the transactions prioritization. */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
