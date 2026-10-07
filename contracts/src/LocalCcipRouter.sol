// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CcipClient} from "./GrantVault.sol";

interface IERC20Pull { function transferFrom(address from, address to, uint256 amount) external returns (bool); }

/// @notice An isolated localhost rehearsal stand-in for a CCIP router. NOT CCIP:
/// it charges a fixed fee, pulls the tokens, records the message and emits it.
/// Nothing crosses a chain. Real evacuations use Chainlink's router on Sepolia.
contract LocalCcipRouter {
    uint256 public immutable fee;
    uint256 public nonce;
    /// @dev Last message, so rehearsal tests can check what the vault asked CCIP to do.
    bytes public lastReceiver;
    bytes public lastExtraArgs;
    uint64 public lastDestination;
    event MessageSent(bytes32 indexed messageId, uint64 indexed destinationChainSelector, address indexed sender, bytes receiver, address token, uint256 amount, uint256 fee, bytes extraArgs);
    error InsufficientFee();
    constructor(uint256 fixedFee) { fee = fixedFee; }
    function getFee(uint64, CcipClient.EVM2AnyMessage calldata) external view returns (uint256) { return fee; }
    function ccipSend(uint64 destinationChainSelector, CcipClient.EVM2AnyMessage calldata message) external payable returns (bytes32 messageId) {
        if (msg.value < fee) revert InsufficientFee();
        require(message.tokenAmounts.length == 1, "One token transfer");
        CcipClient.EVMTokenAmount calldata transfer = message.tokenAmounts[0];
        require(IERC20Pull(transfer.token).transferFrom(msg.sender, address(this), transfer.amount), "Token pull failed");
        messageId = keccak256(abi.encode(block.chainid, address(this), ++nonce, msg.sender));
        lastReceiver = message.receiver;
        lastExtraArgs = message.extraArgs;
        lastDestination = destinationChainSelector;
        emit MessageSent(messageId, destinationChainSelector, msg.sender, message.receiver, transfer.token, transfer.amount, msg.value, message.extraArgs);
    }
}

/// @notice Local stand-in for CCIP-BnM: a plain ERC-20 whose drip() mints one token, like the real test token.
contract LocalBnM {
    string public constant name = "Local CCIP-BnM";
    string public constant symbol = "CCIP-BnM";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function drip(address to) external { totalSupply += 1e18; balanceOf[to] += 1e18; emit Transfer(address(0), to, 1e18); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "Allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "Balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
