// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
interface IReportReceiver { function onReport(bytes calldata metadata, bytes calldata report) external; }
/// @notice An isolated localhost rehearsal transport. NOT a DON or production forwarder.
contract LocalRehearsalForwarder {
    address public immutable owner = msg.sender;
    event ReportDelivered(address indexed receiver, bytes32 indexed reportHash);
    function deliver(address receiver, bytes calldata report) external {
        require(msg.sender == owner, "Unauthorized rehearsal sender");
        IReportReceiver(receiver).onReport("", report);
        emit ReportDelivered(receiver, keccak256(report));
    }
}
