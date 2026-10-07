// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice The subset of Chainlink CCIP's Client library and IRouterClient this
/// vault uses (layouts from the contracts-ccip 2.0.0 npm package).
library CcipClient {
    struct EVMTokenAmount { address token; uint256 amount; }
    struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }
    /// @dev Client.GENERIC_EXTRA_ARGS_V2_TAG; followed by (uint256 gasLimit, bool allowOutOfOrderExecution).
    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;
}
interface ICcipRouter {
    function getFee(uint64 destinationChainSelector, CcipClient.EVM2AnyMessage calldata message) external view returns (uint256 fee);
    function ccipSend(uint64 destinationChainSelector, CcipClient.EVM2AnyMessage calldata message) external payable returns (bytes32 messageId);
}

/// @notice Grant treasury steered by composed Sotto policies.
///
/// It accepts one signed report per execution from an authorized forwarder and
/// can do exactly four things with it, each bounded by limits fixed at deploy:
///   1. pause spending;
///   2. sweep a share of its ETH to the `reserve` address fixed at deploy;
///   3. pay a payee the owner registered, at most `maxPaymentWei` per report
///      and at most once per `minPaymentInterval`, never while paused;
///   4. bridge a share of its CCIP token to `reserve` on the one CCIP
///      destination fixed at deploy, paying the CCIP fee in native ETH.
/// Sweep and evacuation may also pause in the same delivery (FLAG_PAUSE).
///
/// Report v3 binds each delivery to this receiver, this chain, one execution
/// (runId), the policy revision and the structural hash of the exact policy
/// graph that was evaluated. The receiver does not re-run the policy: the
/// workflow that the forwarder authenticates made that decision, and every
/// event repeats the policyHash so anyone can check which graph it was. The
/// worst a misbehaving workflow can do is move funds to the owner's reserve
/// or pay a registered payee within its cap and rate limit.
///
/// Production deployments must use a CRE production forwarder and bind workflow
/// identity; the permissive local forwarder is ONLY for an isolated rehearsal.
contract GrantVault {
    uint256 public constant REPORT_VERSION = 3;
    uint256 public constant ACTION_PAUSE = 1;
    uint256 public constant ACTION_SWEEP = 2;
    uint256 public constant ACTION_PAY = 3;
    uint256 public constant ACTION_EVACUATE = 4;
    uint256 public constant FLAG_PAUSE = 1;
    uint256 public constant BPS = 10_000;
    /// @dev Tolerated disagreement between the workflow's clock and block time.
    uint256 public constant MAX_CLOCK_SKEW = 60;
    uint256 internal constant REPORT_LENGTH = 384;

    /// @notice Deploy-time bounds on every movement a report can make.
    struct Limits {
        address payable reserve;
        uint256 maxSweepBps;
        uint256 maxPaymentWei;
        uint256 minPaymentInterval;
        address ccipRouter;
        address ccipToken;
        uint64 ccipDestination;
    }
    struct Report {
        uint256 version;
        address target;
        uint256 chainId;
        bytes32 runId;
        uint256 revision;
        bytes32 policyHash;
        uint256 action;
        uint256 decidedAt;
        uint256 flags;
        bytes32 payeeId;
        uint256 amount;
        uint64 destinationChainSelector;
    }

    address public immutable owner;
    address public immutable forwarder;
    uint256 public immutable maxReportAge;
    address payable public immutable reserve;
    uint256 public immutable maxSweepBps;
    uint256 public immutable maxPaymentWei;
    uint256 public immutable minPaymentInterval;
    address public immutable ccipRouter;
    address public immutable ccipToken;
    uint64 public immutable ccipDestination;

    bool public paused;
    uint256 public lastPaymentAt;
    mapping(bytes32 => bool) public processedRuns;
    mapping(bytes32 => address payable) public payees;

    event SpendingPaused(bytes32 indexed runId, uint256 indexed revision, bytes32 indexed policyHash, uint256 decidedAt);
    event ReserveSwept(bytes32 indexed runId, uint256 indexed revision, bytes32 indexed policyHash, address reserve, uint256 amount);
    event GrantStreamed(bytes32 indexed runId, uint256 indexed revision, bytes32 indexed policyHash, bytes32 payeeId, address payee, uint256 amount);
    event TreasuryEvacuated(bytes32 indexed runId, uint256 indexed revision, bytes32 indexed policyHash, bytes32 messageId, uint64 destinationChainSelector, address token, uint256 amount, uint256 fee);
    event SpendingResumed();
    event GrantPaid(address indexed recipient, uint256 amount);
    event PayeeSet(bytes32 indexed payeeId, address payee);
    error Unauthorized();
    error InvalidReport();
    error UnsupportedReport();
    error WrongTarget();
    error UnsupportedAction();
    error StaleReport();
    error SpendingIsPaused();
    error InvalidAmount();
    error NothingToMove();
    error UnknownPayee();
    error PaymentTooSoon();
    error EvacuationDisabled();
    error WrongDestination();
    error InsufficientFee();
    error TransferFailed();

    constructor(address authorizedForwarder, uint256 reportAge, Limits memory limits) payable {
        require(authorizedForwarder != address(0) && reportAge > 0 && reportAge <= 3600, "Invalid configuration");
        require(limits.reserve != address(0) && limits.maxSweepBps > 0 && limits.maxSweepBps <= BPS, "Invalid reserve limits");
        require(limits.minPaymentInterval <= 30 days, "Invalid payment interval");
        require(limits.ccipRouter == address(0) || (limits.ccipToken != address(0) && limits.ccipDestination != 0), "Invalid CCIP configuration");
        owner = msg.sender;
        forwarder = authorizedForwarder;
        maxReportAge = reportAge;
        reserve = limits.reserve;
        maxSweepBps = limits.maxSweepBps;
        maxPaymentWei = limits.maxPaymentWei;
        minPaymentInterval = limits.minPaymentInterval;
        ccipRouter = limits.ccipRouter;
        ccipToken = limits.ccipToken;
        ccipDestination = limits.ccipDestination;
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
        if (report.length != REPORT_LENGTH) revert UnsupportedReport();
        Report memory r = abi.decode(report, (Report));
        if (r.version != REPORT_VERSION) revert UnsupportedReport();
        if (r.target != address(this) || r.chainId != block.chainid) revert WrongTarget();
        if (r.action < ACTION_PAUSE || r.action > ACTION_EVACUATE || r.flags > FLAG_PAUSE) revert UnsupportedAction();
        // Only the protective actions may also pause; a payment never does.
        if (r.flags != 0 && r.action != ACTION_SWEEP && r.action != ACTION_EVACUATE) revert UnsupportedAction();
        if (r.runId == bytes32(0) || r.revision == 0 || r.policyHash == bytes32(0)) revert InvalidReport();
        if (processedRuns[r.runId]) return; // duplicate delivery is an explicit no-op
        if (r.decidedAt > block.timestamp + MAX_CLOCK_SKEW || block.timestamp > r.decidedAt + maxReportAge) revert StaleReport();
        processedRuns[r.runId] = true;
        if (r.action == ACTION_PAUSE || r.flags & FLAG_PAUSE != 0) _pause(r);
        if (r.action == ACTION_SWEEP) _sweep(r);
        else if (r.action == ACTION_PAY) _pay(r);
        else if (r.action == ACTION_EVACUATE) _evacuate(r);
    }

    function _pause(Report memory r) internal {
        if (paused) return; // already paused: no second pause, no event
        paused = true;
        emit SpendingPaused(r.runId, r.revision, r.policyHash, r.decidedAt);
    }
    function _sweep(Report memory r) internal {
        if (r.amount == 0 || r.amount > maxSweepBps) revert InvalidAmount();
        uint256 value = address(this).balance * r.amount / BPS;
        if (value == 0) revert NothingToMove();
        (bool success,) = reserve.call{value: value}("");
        if (!success) revert TransferFailed();
        emit ReserveSwept(r.runId, r.revision, r.policyHash, reserve, value);
    }
    function _pay(Report memory r) internal {
        if (paused) revert SpendingIsPaused();
        address payable payee = payees[r.payeeId];
        if (payee == address(0)) revert UnknownPayee();
        if (r.amount == 0 || r.amount > maxPaymentWei) revert InvalidAmount();
        if (lastPaymentAt != 0 && block.timestamp < lastPaymentAt + minPaymentInterval) revert PaymentTooSoon();
        lastPaymentAt = block.timestamp;
        (bool success,) = payee.call{value: r.amount}("");
        if (!success) revert TransferFailed();
        emit GrantStreamed(r.runId, r.revision, r.policyHash, r.payeeId, payee, r.amount);
    }
    function _evacuate(Report memory r) internal {
        if (ccipRouter == address(0)) revert EvacuationDisabled();
        if (r.destinationChainSelector != ccipDestination) revert WrongDestination();
        if (r.amount == 0 || r.amount > BPS) revert InvalidAmount();
        uint256 tokens = IERC20Minimal(ccipToken).balanceOf(address(this)) * r.amount / BPS;
        if (tokens == 0) revert NothingToMove();
        CcipClient.EVMTokenAmount[] memory amounts = new CcipClient.EVMTokenAmount[](1);
        amounts[0] = CcipClient.EVMTokenAmount({token: ccipToken, amount: tokens});
        CcipClient.EVM2AnyMessage memory message = CcipClient.EVM2AnyMessage({
            receiver: abi.encode(reserve),
            data: "",
            tokenAmounts: amounts,
            feeToken: address(0),
            // Token-only transfer to an account: no receiver execution gas.
            extraArgs: abi.encodeWithSelector(CcipClient.GENERIC_EXTRA_ARGS_V2_TAG, uint256(0), true)
        });
        uint256 fee = ICcipRouter(ccipRouter).getFee(ccipDestination, message);
        if (fee > address(this).balance) revert InsufficientFee();
        if (!IERC20Minimal(ccipToken).approve(ccipRouter, tokens)) revert TransferFailed();
        bytes32 messageId = ICcipRouter(ccipRouter).ccipSend{value: fee}(ccipDestination, message);
        emit TreasuryEvacuated(r.runId, r.revision, r.policyHash, messageId, ccipDestination, ccipToken, tokens, fee);
    }

    function setPayee(bytes32 payeeId, address payable payee) external {
        if (msg.sender != owner) revert Unauthorized();
        payees[payeeId] = payee;
        emit PayeeSet(payeeId, payee);
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
