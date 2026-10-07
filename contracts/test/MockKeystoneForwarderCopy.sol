// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Test-only copy of Chainlink's MockKeystoneForwarder (chainlink-evm
/// contracts/cre/src/dev/MockKeystoneForwarder.sol), the forwarder that
/// `cre workflow simulate --broadcast` delivers through on Sepolia. Ownership
/// and ITypeAndVersion are dropped; routing, gas handling and ERC165 checks are
/// kept verbatim so local tests reproduce what the receiver sees.
interface IERC165Like { function supportsInterface(bytes4 interfaceId) external view returns (bool); }
interface IReceiverLike { function onReport(bytes calldata metadata, bytes calldata report) external; }

library ERC165CheckerCopy {
    // OpenZeppelin 4.8.3 ERC165Checker
    bytes4 private constant _INTERFACE_ID_INVALID = 0xffffffff;
    function supportsERC165(address account) internal view returns (bool) {
        return supportsERC165InterfaceUnchecked(account, type(IERC165Like).interfaceId) &&
            !supportsERC165InterfaceUnchecked(account, _INTERFACE_ID_INVALID);
    }
    function supportsInterface(address account, bytes4 interfaceId) internal view returns (bool) {
        return supportsERC165(account) && supportsERC165InterfaceUnchecked(account, interfaceId);
    }
    function supportsERC165InterfaceUnchecked(address account, bytes4 interfaceId) internal view returns (bool) {
        bytes memory encodedParams = abi.encodeWithSelector(IERC165Like.supportsInterface.selector, interfaceId);
        bool success;
        uint256 returnSize;
        uint256 returnValue;
        assembly {
            success := staticcall(30000, account, add(encodedParams, 0x20), mload(encodedParams), 0x00, 0x20)
            returnSize := returndatasize()
            returnValue := mload(0x00)
        }
        return success && returnSize >= 0x20 && returnValue > 0;
    }
}

contract MockKeystoneForwarderCopy {
    error InvalidReport();
    struct Transmission { address transmitter; bool invalidReceiver; bool success; uint80 gasLimit; }
    event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result);
    uint256 internal constant METADATA_LENGTH = 109;
    uint256 internal constant FORWARDER_METADATA_LENGTH = 45;
    mapping(bytes32 => Transmission) internal s_transmissions;

    function route(bytes32 transmissionId, address transmitter, address receiver, bytes calldata metadata, bytes calldata validatedReport) public returns (bool) {
        s_transmissions[transmissionId].transmitter = transmitter;
        s_transmissions[transmissionId].gasLimit = uint80(gasleft());
        if (!ERC165CheckerCopy.supportsInterface(receiver, type(IReceiverLike).interfaceId)) {
            s_transmissions[transmissionId].invalidReceiver = true;
            return false;
        }
        bool success;
        bytes memory payload = abi.encodeCall(IReceiverLike.onReport, (metadata, validatedReport));
        assembly {
            success := call(gas(), receiver, 0, add(payload, 0x20), mload(payload), 0x0, 0x0)
        }
        s_transmissions[transmissionId].success = success;
        return success;
    }

    function getTransmissionId(address receiver, bytes32 workflowExecutionId, bytes2 reportId) public pure returns (bytes32) {
        return keccak256(bytes.concat(bytes20(uint160(receiver)), workflowExecutionId, reportId));
    }

    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external {
        if (rawReport.length < METADATA_LENGTH) revert InvalidReport();
        (bytes32 workflowExecutionId, bytes2 reportId) = _getMetadata(rawReport);
        bool success = this.route(
            getTransmissionId(receiver, workflowExecutionId, reportId),
            msg.sender,
            receiver,
            rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH],
            rawReport[METADATA_LENGTH:]
        );
        emit ReportProcessed(receiver, workflowExecutionId, reportId, success);
    }

    function _getMetadata(bytes memory rawReport) internal pure returns (bytes32 workflowExecutionId, bytes2 reportId) {
        assembly {
            workflowExecutionId := mload(add(rawReport, 33))
            reportId := mload(add(rawReport, 139))
        }
    }
}
