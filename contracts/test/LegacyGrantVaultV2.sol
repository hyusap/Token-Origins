// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice TEST COPY of the report-v2 GrantVault deployed on Sepolia before treasury actions.
/// Kept so runner compatibility (pause-only v2 reports) stays tested.
/// Grant treasury. Accepts one bounded action from an authorized forwarder:
/// pausing spending when a composed Sotto policy evaluated true.
///
/// Report v2 binds each delivery to this receiver, this chain, one execution
/// (runId), the policy revision, and the structural hash of the exact policy
/// graph that was evaluated. The receiver does not re-run the policy: the
/// workflow that the forwarder authenticates made that decision, and the
/// emitted policyHash lets anyone check which graph it was.
///
/// Production deployments must use a CRE production forwarder and bind workflow
/// identity; the permissive local forwarder is ONLY for an isolated rehearsal.
contract LegacyGrantVaultV2 {
    uint256 public constant REPORT_VERSION = 2;
    uint256 public constant ACTION_PAUSE = 1;
    /// @dev Tolerated disagreement between the workflow's clock and block time.
    uint256 public constant MAX_CLOCK_SKEW = 60;

    address public immutable owner;
    address public immutable forwarder;
    uint256 public immutable maxReportAge;
    bool public paused;
    mapping(bytes32 => bool) public processedRuns;

    event SpendingPaused(bytes32 indexed runId, uint256 indexed revision, bytes32 indexed policyHash, uint256 decidedAt);
    event SpendingResumed();
    event GrantPaid(address indexed recipient, uint256 amount);
    error Unauthorized();
    error InvalidReport();
    error UnsupportedReport();
    error WrongTarget();
    error UnsupportedAction();
    error StaleReport();
    error SpendingIsPaused();

    constructor(address authorizedForwarder, uint256 reportAge) payable {
        require(authorizedForwarder != address(0) && reportAge > 0 && reportAge <= 3600, "Invalid configuration");
        owner = msg.sender;
        forwarder = authorizedForwarder;
        maxReportAge = reportAge;
    }
    receive() external payable {}
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == bytes4(keccak256("onReport(bytes,bytes)"));
    }
    function name() external pure returns (string memory) { return "Origins grant vault"; }
    /// @notice Lets runners refuse to submit a report layout this receiver cannot decode.
    function reportVersion() external pure returns (uint256) { return REPORT_VERSION; }

    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert Unauthorized();
        if (report.length < 256) revert UnsupportedReport();
        (uint256 version, address target, uint256 chainId, bytes32 runId, uint256 revision, bytes32 policyHash, uint256 action, uint256 decidedAt) =
            abi.decode(report, (uint256, address, uint256, bytes32, uint256, bytes32, uint256, uint256));
        if (version != REPORT_VERSION) revert UnsupportedReport();
        if (target != address(this) || chainId != block.chainid) revert WrongTarget();
        if (action != ACTION_PAUSE) revert UnsupportedAction();
        if (runId == bytes32(0) || revision == 0 || policyHash == bytes32(0)) revert InvalidReport();
        if (processedRuns[runId]) return; // duplicate delivery is an explicit no-op
        if (decidedAt > block.timestamp + MAX_CLOCK_SKEW || block.timestamp > decidedAt + maxReportAge) revert StaleReport();
        processedRuns[runId] = true;
        if (paused) return;
        paused = true;
        emit SpendingPaused(runId, revision, policyHash, decidedAt);
    }
    function resume() external {
        if (msg.sender != owner) revert Unauthorized();
        paused = false;
        emit SpendingResumed();
    }
    function payGrant(address payable recipient, uint256 amount) external {
        if (msg.sender != owner) revert Unauthorized();
        if (paused) revert SpendingIsPaused();
        (bool success,) = recipient.call{value: amount}("");
        require(success, "Transfer failed");
        emit GrantPaid(recipient, amount);
    }
}
