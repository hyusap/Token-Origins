// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A real ERC20 used only to provide disposable AMM test liquidity.
/// No public-market value, oracle price, or production token identity is implied.
contract RehearsalTradeToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory n, string memory s) { name = n; symbol = s; owner = msg.sender; }
    function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); require(to != address(0), "zero"); totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { uint256 permitted = allowance[from][msg.sender]; require(permitted >= amount, "allowance"); if (permitted != type(uint256).max) allowance[from][msg.sender] = permitted - amount; _transfer(from, to, amount); return true; }
    function _transfer(address from, address to, uint256 amount) internal { require(to != address(0), "zero"); require(balanceOf[from] >= amount, "balance"); balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}
