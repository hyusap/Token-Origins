// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GrantVault} from "../src/GrantVault.sol";
import {LocalRehearsalForwarder} from "../src/LocalRehearsalForwarder.sol";
import {LocalCcipRouter, LocalBnM} from "../src/LocalCcipRouter.sol";
import {LegacyGrantVaultV2} from "./LegacyGrantVaultV2.sol";
interface Vm { function warp(uint256) external; function expectRevert(bytes4) external; function prank(address) external; function deal(address,uint256) external; }
contract GrantVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GrantVault vault;
    LocalRehearsalForwarder forwarder;
    LocalCcipRouter router;
    LocalBnM bnm;
    bytes32 constant POLICY = keccak256("policy");
    bytes32 constant GRANTEE = keccak256("grantee");
    address payable constant RESERVE = payable(address(0xBEEF01));
    address payable constant PAYEE = payable(address(0xBEEF02));
    uint64 constant BASE_SEPOLIA = 10344971235874465080;
    uint256 constant PAUSE = 1; uint256 constant SWEEP = 2; uint256 constant PAY = 3; uint256 constant EVACUATE = 4;

    function limits(uint256 maxSweepBps, address ccipRouter) internal view returns (GrantVault.Limits memory) {
        return GrantVault.Limits({reserve: RESERVE, maxSweepBps: maxSweepBps, maxPaymentWei: 0.05 ether, minPaymentInterval: 60,
            ccipRouter: ccipRouter, ccipToken: ccipRouter == address(0) ? address(0) : address(bnm), ccipDestination: ccipRouter == address(0) ? 0 : BASE_SEPOLIA});
    }
    function setUp() public {
        vm.warp(10000);
        forwarder = new LocalRehearsalForwarder();
        router = new LocalCcipRouter(0.001 ether);
        bnm = new LocalBnM();
        vault = new GrantVault(address(forwarder), 120, limits(10_000, address(router)));
        vault.setPayee(GRANTEE, PAYEE);
    }
    function report(bytes32 id, uint256 action, uint256 flags, bytes32 payee, uint256 amount, uint64 dest, uint256 decidedAt) internal view returns (bytes memory) {
        return abi.encode(GrantVault.Report(3, address(vault), block.chainid, id, 1, POLICY, action, decidedAt, flags, payee, amount, dest));
    }
    function pause(bytes32 id, uint256 decidedAt) internal view returns (bytes memory) { return report(id, PAUSE, 0, bytes32(0), 0, 0, decidedAt); }
    function custom(uint256 version, address target, uint256 chainId, bytes32 id, uint256 revision, bytes32 policy, uint256 action, uint256 flags) internal pure returns (bytes memory) {
        return abi.encode(GrantVault.Report(version, target, chainId, id, revision, policy, action, 10000, flags, bytes32(0), 0, 0));
    }

    // ---- identity, authorization, replay, age (carried over from report v2) ----
    function testPauseAndReplayIdempotence() public {
        bytes memory r = pause(bytes32(uint256(1)), 10000);
        forwarder.deliver(address(vault), r);
        require(vault.paused() && vault.processedRuns(bytes32(uint256(1))));
        vault.resume(); forwarder.deliver(address(vault), r); require(!vault.paused(), "replay paused again");
    }
    function testReportsVersion() public view { require(vault.reportVersion() == 3); }
    function testRejectUnauthorizedSender() public { vm.expectRevert(GrantVault.Unauthorized.selector); vault.onReport("", pause(bytes32(uint256(1)), 10000)); }
    function testRejectStaleAndFuture() public {
        vm.expectRevert(GrantVault.StaleReport.selector); forwarder.deliver(address(vault), pause(bytes32(uint256(1)), 9879));
        vm.expectRevert(GrantVault.StaleReport.selector); forwarder.deliver(address(vault), pause(bytes32(uint256(1)), 10061));
        forwarder.deliver(address(vault), pause(bytes32(uint256(2)), 10060));
        vault.resume(); forwarder.deliver(address(vault), pause(bytes32(uint256(3)), 9880));
        require(vault.paused());
    }
    function testRejectWrongVersionTargetChainActionAndFlags() public {
        address self = address(vault);
        vm.expectRevert(GrantVault.UnsupportedReport.selector); forwarder.deliver(self, custom(2, self, block.chainid, bytes32(uint256(1)), 1, POLICY, PAUSE, 0));
        vm.expectRevert(GrantVault.WrongTarget.selector); forwarder.deliver(self, custom(3, address(0xBEEF), block.chainid, bytes32(uint256(1)), 1, POLICY, PAUSE, 0));
        vm.expectRevert(GrantVault.WrongTarget.selector); forwarder.deliver(self, custom(3, self, block.chainid + 1, bytes32(uint256(1)), 1, POLICY, PAUSE, 0));
        vm.expectRevert(GrantVault.UnsupportedAction.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 1, POLICY, 5, 0));
        vm.expectRevert(GrantVault.UnsupportedAction.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 1, POLICY, 0, 0));
        vm.expectRevert(GrantVault.UnsupportedAction.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 1, POLICY, SWEEP, 2));
        // A payment never carries the pause flag.
        vm.expectRevert(GrantVault.UnsupportedAction.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 1, POLICY, PAY, 1));
        require(!vault.paused());
    }
    function testRejectMissingIdentity() public {
        address self = address(vault);
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(0), 1, POLICY, PAUSE, 0));
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 0, POLICY, PAUSE, 0));
        vm.expectRevert(GrantVault.InvalidReport.selector); forwarder.deliver(self, custom(3, self, block.chainid, bytes32(uint256(1)), 1, bytes32(0), PAUSE, 0));
    }
    function testRejectOlderReportLayouts() public {
        // v1 scalar layout and the v2 pause layout are both refused by length before decoding.
        vm.expectRevert(GrantVault.UnsupportedReport.selector);
        forwarder.deliver(address(vault), abi.encode(bytes32(uint256(1)), uint256(1), uint256(200000), uint256(300000), uint256(10000)));
        vm.expectRevert(GrantVault.UnsupportedReport.selector);
        forwarder.deliver(address(vault), abi.encode(uint256(2), address(vault), block.chainid, bytes32(uint256(1)), uint256(1), POLICY, uint256(1), uint256(10000)));
    }
    function testAlreadyPausedNewRunNoop() public {
        forwarder.deliver(address(vault), pause(bytes32(uint256(1)), 10000));
        forwarder.deliver(address(vault), pause(bytes32(uint256(2)), 10000));
        require(vault.paused() && vault.processedRuns(bytes32(uint256(2))));
    }
    function testSpendingBlockedAfterPause() public {
        vm.deal(address(vault), 1 ether);
        forwarder.deliver(address(vault), pause(bytes32(uint256(1)), 10000));
        vm.expectRevert(GrantVault.SpendingIsPaused.selector); vault.payGrant(payable(address(0x123)), 0.1 ether);
    }
    function testOnlyOwnerCanResumePayAndRegisterPayees() public {
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.resume();
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.payGrant(payable(address(1)), 1);
        vm.prank(address(0x123)); vm.expectRevert(GrantVault.Unauthorized.selector); vault.setPayee(keccak256("attacker"), payable(address(0x123)));
    }

    // ---- sweep ----
    function testSweepMovesAShareToTheReserveAndCanPause() public {
        vm.deal(address(vault), 1 ether);
        forwarder.deliver(address(vault), report(bytes32(uint256(1)), SWEEP, 1, bytes32(0), 5000, 0, 10000));
        require(RESERVE.balance == 0.5 ether && address(vault).balance == 0.5 ether && vault.paused(), "half swept and paused");
        // Sweeping is protective: it still runs on a paused vault.
        forwarder.deliver(address(vault), report(bytes32(uint256(2)), SWEEP, 0, bytes32(0), 10_000, 0, 10000));
        require(RESERVE.balance == 1 ether && address(vault).balance == 0, "rest swept while paused");
        vm.expectRevert(GrantVault.NothingToMove.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(3)), SWEEP, 0, bytes32(0), 10_000, 0, 10000));
    }
    function testSweepIsCappedAtDeploy() public {
        GrantVault capped = new GrantVault(address(forwarder), 120, limits(2500, address(0)));
        vm.deal(address(capped), 1 ether);
        bytes memory tooMuch = abi.encode(GrantVault.Report(3, address(capped), block.chainid, bytes32(uint256(1)), 1, POLICY, SWEEP, 10000, 0, bytes32(0), 2501, 0));
        vm.expectRevert(GrantVault.InvalidAmount.selector); forwarder.deliver(address(capped), tooMuch);
        bytes memory zero = abi.encode(GrantVault.Report(3, address(capped), block.chainid, bytes32(uint256(1)), 1, POLICY, SWEEP, 10000, 0, bytes32(0), 0, 0));
        vm.expectRevert(GrantVault.InvalidAmount.selector); forwarder.deliver(address(capped), zero);
    }

    // ---- pay ----
    function testPaysARegisteredPayeeWithinCapAndRateLimit() public {
        vm.deal(address(vault), 1 ether);
        forwarder.deliver(address(vault), report(bytes32(uint256(1)), PAY, 0, GRANTEE, 0.01 ether, 0, 10000));
        require(PAYEE.balance == 0.01 ether && vault.lastPaymentAt() == 10000, "first payment");
        vm.expectRevert(GrantVault.PaymentTooSoon.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(2)), PAY, 0, GRANTEE, 0.01 ether, 0, 10000));
        vm.warp(10060);
        forwarder.deliver(address(vault), report(bytes32(uint256(3)), PAY, 0, GRANTEE, 0.01 ether, 0, 10060));
        require(PAYEE.balance == 0.02 ether, "second payment after the interval");
        vm.warp(10200);
        vm.expectRevert(GrantVault.InvalidAmount.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(4)), PAY, 0, GRANTEE, 0.06 ether, 0, 10200));
        vm.expectRevert(GrantVault.UnknownPayee.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(5)), PAY, 0, keccak256("attacker"), 0.01 ether, 0, 10200));
    }
    function testNoPaymentWhilePaused() public {
        vm.deal(address(vault), 1 ether);
        forwarder.deliver(address(vault), pause(bytes32(uint256(1)), 10000));
        vm.expectRevert(GrantVault.SpendingIsPaused.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(2)), PAY, 0, GRANTEE, 0.01 ether, 0, 10000));
        require(PAYEE.balance == 0);
    }

    // ---- evacuate (CCIP) ----
    function testEvacuateBridgesTokensToTheReserveThroughCcip() public {
        vm.deal(address(vault), 1 ether);
        bnm.drip(address(vault)); bnm.drip(address(vault));
        forwarder.deliver(address(vault), report(bytes32(uint256(1)), EVACUATE, 1, bytes32(0), 5000, BASE_SEPOLIA, 10000));
        require(bnm.balanceOf(address(router)) == 1e18 && bnm.balanceOf(address(vault)) == 1e18, "half the tokens handed to CCIP");
        require(address(router).balance == 0.001 ether && address(vault).balance == 0.999 ether, "fee paid in native ETH");
        require(router.nonce() == 1 && router.lastDestination() == BASE_SEPOLIA && vault.paused(), "one message to Base Sepolia, and paused");
        require(keccak256(router.lastReceiver()) == keccak256(abi.encode(RESERVE)), "tokens go to the reserve");
        require(keccak256(router.lastExtraArgs()) == keccak256(abi.encodeWithSelector(bytes4(0x181dcf10), uint256(0), true)), "GenericExtraArgsV2, no receiver gas");
    }
    function testEvacuateRefusesWrongDestinationEmptyVaultMissingFeeAndUnconfiguredCcip() public {
        bnm.drip(address(vault));
        vm.expectRevert(GrantVault.WrongDestination.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(1)), EVACUATE, 0, bytes32(0), 10_000, 5009297550715157269, 10000));
        vm.expectRevert(GrantVault.InsufficientFee.selector);
        forwarder.deliver(address(vault), report(bytes32(uint256(1)), EVACUATE, 0, bytes32(0), 10_000, BASE_SEPOLIA, 10000));
        GrantVault noCcip = new GrantVault(address(forwarder), 120, limits(10_000, address(0)));
        vm.expectRevert(GrantVault.EvacuationDisabled.selector);
        forwarder.deliver(address(noCcip), abi.encode(GrantVault.Report(3, address(noCcip), block.chainid, bytes32(uint256(1)), 1, POLICY, EVACUATE, 10000, 0, bytes32(0), 10_000, BASE_SEPOLIA)));
        GrantVault empty = new GrantVault(address(forwarder), 120, limits(10_000, address(router)));
        vm.deal(address(empty), 1 ether);
        vm.expectRevert(GrantVault.NothingToMove.selector);
        forwarder.deliver(address(empty), abi.encode(GrantVault.Report(3, address(empty), block.chainid, bytes32(uint256(1)), 1, POLICY, EVACUATE, 10000, 0, bytes32(0), 10_000, BASE_SEPOLIA)));
    }

    // ---- the v2 vault already on Sepolia keeps accepting the pause layout the runner still sends it ----
    function testLegacyV2VaultStillPausesOnV2Reports() public {
        LegacyGrantVaultV2 legacy = new LegacyGrantVaultV2(address(forwarder), 120);
        forwarder.deliver(address(legacy), abi.encode(uint256(2), address(legacy), block.chainid, bytes32(uint256(1)), uint256(1), POLICY, uint256(1), uint256(10000)));
        require(legacy.paused() && legacy.reportVersion() == 2);
    }
}
