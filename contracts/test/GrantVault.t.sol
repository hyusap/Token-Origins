// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GrantVault} from "../src/GrantVault.sol";
import {LocalRehearsalForwarder} from "../src/LocalRehearsalForwarder.sol";
interface Vm { function warp(uint256) external; function expectRevert(bytes4) external; function prank(address) external; function deal(address,uint256) external; function chainId(uint256) external; }
contract GrantVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GrantVault vault;
    LocalRehearsalForwarder forwarder;
    bytes32 constant POLICY = keccak256("policy");
    function setUp() public { vm.warp(10000); forwarder=new LocalRehearsalForwarder(); vault=new GrantVault(address(forwarder),120); }
    function report(bytes32 id,uint256 decidedAt) internal view returns(bytes memory) {
        return abi.encode(uint256(2),address(vault),block.chainid,id,uint256(1),POLICY,uint256(1),decidedAt);
    }
    function custom(uint256 version,address target,uint256 chainId,bytes32 id,uint256 revision,bytes32 policy,uint256 action) internal pure returns(bytes memory) {
        return abi.encode(version,target,chainId,id,revision,policy,action,uint256(10000));
    }
    function testPauseAndReplayIdempotence() public {
        bytes memory r=report(bytes32(uint256(1)),10000);
        forwarder.deliver(address(vault),r);
        require(vault.paused() && vault.processedRuns(bytes32(uint256(1))));
        vault.resume(); forwarder.deliver(address(vault),r); require(!vault.paused(),"replay paused again");
    }
    function testReportsVersion() public view { require(vault.reportVersion()==2); }
    function testRejectUnauthorizedSender() public { vm.expectRevert(GrantVault.Unauthorized.selector); vault.onReport("",report(bytes32(uint256(1)),10000)); }
    function testRejectStaleAndFuture() public {
        vm.expectRevert(GrantVault.StaleReport.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),9879));
        vm.expectRevert(GrantVault.StaleReport.selector); forwarder.deliver(address(vault),report(bytes32(uint256(1)),10061));
        // Inside the skew and age windows both ends are accepted.
        forwarder.deliver(address(vault),report(bytes32(uint256(2)),10060));
        vault.resume(); forwarder.deliver(address(vault),report(bytes32(uint256(3)),9880));
        require(vault.paused());
    }
    function testRejectWrongVersionTargetChainAndAction() public {
        address self=address(vault);
        vm.expectRevert(GrantVault.UnsupportedReport.selector); forwarder.deliver(self,custom(1,self,block.chainid,bytes32(uint256(1)),1,POLICY,1));
        vm.expectRevert(GrantVault.WrongTarget.selector); forwarder.deliver(self,custom(2,address(0xBEEF),block.chainid,bytes32(uint256(1)),1,POLICY,1));
        vm.expectRevert(GrantVault.WrongTarget.selector); forwarder.deliver(self,custom(2,self,block.chainid+1,bytes32(uint256(1)),1,POLICY,1));
        vm.expectRevert(GrantVault.UnsupportedAction.selector); forwarder.deliver(self,custom(2,self,block.chainid,bytes32(uint256(1)),1,POLICY,2));
        require(!vault.paused());
    }
    function testRejectMissingIdentity() public {
        address self=address(vault);
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self,custom(2,self,block.chainid,bytes32(0),1,POLICY,1));
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self,custom(2,self,block.chainid,bytes32(uint256(1)),0,POLICY,1));
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self,custom(2,self,block.chainid,bytes32(uint256(1)),1,bytes32(0),1));
    }
    function testRejectOldScalarReport() public {
        // The v1 layout (runId, revision, priceCents, thresholdCents, observedAt) is not decoded as v2.
        vm.expectRevert(GrantVault.UnsupportedReport.selector);
        forwarder.deliver(address(vault),abi.encode(bytes32(uint256(1)),uint256(1),uint256(200000),uint256(300000),uint256(10000)));
    }
    function testAlreadyPausedNewRunNoop() public {
        forwarder.deliver(address(vault),report(bytes32(uint256(1)),10000));
        forwarder.deliver(address(vault),report(bytes32(uint256(2)),10000));
        require(vault.paused() && vault.processedRuns(bytes32(uint256(2))));
    }
    function testSpendingBlockedAfterPause() public {
        vm.deal(address(vault),1 ether);
        forwarder.deliver(address(vault),report(bytes32(uint256(1)),10000));
        vm.expectRevert(GrantVault.SpendingIsPaused.selector); vault.payGrant(payable(address(0x123)),0.1 ether);
    }
    function testOnlyOwnerCanResumeAndPay() public {
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.resume();
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.payGrant(payable(address(1)),1);
    }
}
