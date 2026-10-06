// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GrantVault} from "../src/GrantVault.sol";
import {LocalRehearsalForwarder} from "../src/LocalRehearsalForwarder.sol";
interface Vm { function warp(uint256) external; function expectRevert(bytes4) external; function prank(address) external; function deal(address,uint256) external; }
contract GrantVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GrantVault vault;
    LocalRehearsalForwarder forwarder;
    function setUp() public { vm.warp(10000); forwarder=new LocalRehearsalForwarder(); vault=new GrantVault(address(forwarder),120); }
    function report(bytes32 id,uint256 price,uint256 threshold,uint256 time) internal pure returns(bytes memory) { return abi.encode(id,uint256(1),price,threshold,time); }
    function testPauseAndReplayIdempotence() public {
        bytes memory r=report(bytes32(uint256(1)),200000,300000,10000);
        forwarder.deliver(address(vault),r);
        require(vault.paused() && vault.processedRuns(bytes32(uint256(1))));
        vault.resume(); forwarder.deliver(address(vault),r); require(!vault.paused(),"replay paused again");
    }
    function testRejectUnauthorizedSender() public { vm.expectRevert(GrantVault.Unauthorized.selector); vault.onReport("",report(bytes32(uint256(1)),200000,300000,10000)); }
    function testRejectStaleAndFuture() public {
        vm.expectRevert(GrantVault.StaleObservation.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),200000,300000,9879));
        vm.expectRevert(GrantVault.StaleObservation.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),200000,300000,10001));
    }
    function testRejectFalseThresholdAndZeroPrice() public {
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),300000,300000,10000));
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),0,300000,10000));
    }
    function testAlreadyPausedNewRunNoop() public {
        forwarder.deliver(address(vault),report(bytes32(uint256(1)),200000,300000,10000));
        forwarder.deliver(address(vault),report(bytes32(uint256(2)),200000,300000,10000));
        require(vault.paused() && vault.processedRuns(bytes32(uint256(2))));
    }
    function testSpendingBlockedAfterPause() public {
        vm.deal(address(vault),1 ether);
        forwarder.deliver(address(vault),report(bytes32(uint256(1)),200000,300000,10000));
        vm.expectRevert(GrantVault.SpendingIsPaused.selector); vault.payGrant(payable(address(0x123)),0.1 ether);
    }
    function testOnlyOwnerCanResumeAndPay() public {
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.resume();
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.payGrant(payable(address(1)),1);
    }
}
