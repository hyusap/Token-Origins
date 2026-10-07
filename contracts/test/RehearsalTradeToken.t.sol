// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {RehearsalTradeToken} from "../src/RehearsalTradeToken.sol";
interface TradeVm { function prank(address) external; function expectRevert() external; }
contract RehearsalTradeTokenTest {
    TradeVm constant vm = TradeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testExactTransfersAndBoundedApproval() public { RehearsalTradeToken t = new RehearsalTradeToken("Disposable A", "dA"); t.mint(address(this),100 ether);t.approve(address(0x123),20 ether);vm.prank(address(0x123));t.transferFrom(address(this),address(0x456),20 ether);require(t.balanceOf(address(this))==80 ether&&t.balanceOf(address(0x456))==20 ether&&t.allowance(address(this),address(0x123))==0);vm.prank(address(0x123));vm.expectRevert();t.transferFrom(address(this),address(0x456),1); }
    function testUnauthorizedMintFails() public { RehearsalTradeToken t = new RehearsalTradeToken("Disposable A", "dA");vm.prank(address(0x123));vm.expectRevert();t.mint(address(0x123),100 ether);require(t.totalSupply()==0); }
}
