// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Grant treasury. This receiver accepts a bounded spending-pause report.
/// Production deployments must use a CRE production forwarder and bind workflow
/// identity; the permissive local forwarder is ONLY for an isolated rehearsal.
contract GrantVault {
    address public immutable owner;
    address public immutable forwarder;
    uint256 public immutable maxReportAge;
    bool public paused;
    mapping(bytes32 => bool) public processedRuns;
    event SpendingPaused(bytes32 indexed runId, uint256 indexed revision, uint256 priceUsdCents, uint256 thresholdUsdCents, uint256 observedAt);
    event SpendingResumed();
    event GrantPaid(address indexed recipient, uint256 amount);
    error Unauthorized();
    error InvalidReport();
    error StaleObservation();
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
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert Unauthorized();
        (bytes32 runId, uint256 revision, uint256 price, uint256 threshold, uint256 observedAt) =
            abi.decode(report, (bytes32, uint256, uint256, uint256, uint256));
        if (processedRuns[runId]) return; // duplicate delivery is an explicit no-op
        if (runId == bytes32(0) || revision == 0 || price == 0 || price >= threshold) revert InvalidReport();
        if (observedAt > block.timestamp || block.timestamp - observedAt > maxReportAge) revert StaleObservation();
        processedRuns[runId] = true;
        if (paused) return;
        paused = true;
        emit SpendingPaused(runId, revision, price, threshold, observedAt);
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
