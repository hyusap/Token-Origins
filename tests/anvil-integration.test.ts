// Real local EVM: deploys the v3 vault on a throwaway Anvil node and runs the
// actual runner, receiver, proof sequence, independent verifier and restart
// reconciliation against it. Prices are injected (no network needed); every
// transaction, event and state read is real. Skips when Foundry is not
// installed or contracts are not built (forge build --root contracts).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createPublicClient, createWalletClient, http, defineChain, parseEther, parseAbi, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRehearsalRun, findSubmittedPause, type LocalDeployment } from "../cre/runner";
// Local Anvil runs use the explicit research path; the product executes only through CRE.
import { sourceIdentity, FEED_REGISTRY, policyGraphSchema, type FeedSource, type Observation } from "../cre/graph";
import { deployLocalTreasury, LOCAL_RESERVE, LOCAL_PAYEES, LOCAL_CCIP_FEE, type LocalTreasury } from "../cre/local-deploy";
import { proveSequence, specOf, composedPause } from "../scripts/prove-execution";
import { verifyEvidenceFile } from "../scripts/verify-evidence";
import { alignLocalClock, deployedReportVersion, rpcAt } from "../scripts/local-chain";

const anvil = Bun.which("anvil");
const artifacts = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").exists();
const enabled = Boolean(anvil && artifacts);
const PORT = 8599;
const rpcUrl = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const vaultAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "resume", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
let node: ReturnType<typeof Bun.spawn> | undefined;
let deployment: LocalDeployment;
let treasury: LocalTreasury;
let ethUsd = 2500;

async function startAnvil(extra: string[] = []) {
  const proc = Bun.spawn([anvil!, "--port", String(PORT), "--chain-id", "31337", "--silent", ...extra], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await client.getChainId(); return proc; } catch { await Bun.sleep(100); }
  }
  throw new Error("Anvil did not start");
}
async function deploy(): Promise<LocalDeployment> {
  treasury = await deployLocalTreasury(client as PublicClient, wallet as any, { fundEth: "1" });
  return { address: treasury.address, forwarder: treasury.forwarder, chainId: 31337, rpcUrl, blockNumber: treasury.blockNumber };
}
const fetchExchange = async (): Promise<Observation> => ({
  ...sourceIdentity({ type: "exchange-trade", pair: "ETH-USD" }), value: ethUsd, usd: ethUsd, raw: String(ethUsd),
  observedAt: new Date(Date.now() - 2000).toISOString(), fetchedAt: new Date().toISOString(),
});
const resolveFeed = async (source: FeedSource): Promise<Observation> => ({
  ...sourceIdentity(source), value: 85000, usd: 85000, raw: "8500000000000", roundId: "1",
  observedAt: new Date(Date.now() - 600_000).toISOString(), fetchedAt: new Date().toISOString(),
});
const isPaused = () => client.readContract({ address: deployment.address as Address, abi: vaultAbi, functionName: "paused" });
const resume = async () => {
  const hash = await wallet.writeContract({ address: deployment.address as Address, abi: vaultAbi, functionName: "resume" });
  await client.waitForTransactionReceipt({ hash });
  return hash;
};

beforeAll(async () => {
  if (!enabled) return;
  node = await startAnvil();
  deployment = await deploy();
});
afterAll(() => node?.kill());

test.skipIf(!enabled)("the deployed vault reports v3 and a stale clock is aligned without losing state", async () => {
  expect(await deployedReportVersion(rpcAt(rpcUrl), deployment.address)).toBe(3);
  expect(await deployedReportVersion(rpcAt(rpcUrl), "0x000000000000000000000000000000000000dEaD")).toBeNull();
  const aligned = await alignLocalClock(rpcAt(rpcUrl), () => Math.floor(Date.now() / 1000) + 3600);
  expect(aligned.minedAlignmentBlock).toBe(true);
  expect(Math.abs(aligned.lagAfter)).toBeLessThanOrEqual(5);
  expect(await deployedReportVersion(rpcAt(rpcUrl), deployment.address)).toBe(3);
  // Bring the chain back near real time for the runs below: later blocks follow the new offset.
  await rpcAt(rpcUrl)("evm_setTime", [Math.floor(Date.now() / 1000)]);
  await rpcAt(rpcUrl)("evm_mine", []);
});

test.skipIf(!enabled)("full local proof: false, verified composed pause, no duplicate, sell never writes; then independent verification", async () => {
  ethUsd = 2500;
  const execute = (spec: any) => executeRehearsalRun(spec, undefined, { deployment, fetchExchange, resolveFeed });
  const proof = await proveSequence({ label: "anvil-integration", feedNetwork: "ethereum-mainnet", execute, isPaused, resume, log: () => {} });
  expect(proof.cases.trueCondition.evidence.transaction?.receiverConfirmed).toBe(true);
  expect(proof.cases.trueCondition.evidence.observations.map((o) => o.key)).toEqual(["exchange-trade:ETH-USD", "chainlink-feed:ethereum-mainnet:BTC"]);
  expect(proof.cases.trueCondition.evidence.observations[1]!.address).toBe(FEED_REGISTRY["ethereum-mainnet"].BTC!);
  // CRE-only product: an unsupported action is refused before any execution.
  expect(proof.cases.unsupportedAction.executionCalled).toBe(false);
  expect(proof.cases.unsupportedAction.refused).toBeTruthy();
  expect(await isPaused()).toBe(false);

  const dir = await mkdtemp(join(tmpdir(), "sotto-proof-"));
  const file = join(dir, "evidence.json");
  await Bun.write(file, JSON.stringify({ chainId: 31337, vault: deployment.address, rpcUrl, ...proof }));
  const verified = await verifyEvidenceFile(file);
  expect(verified.checks).toMatchObject({
    "trueCondition.policyHashRecomputed": true, "pause.receiptSuccess": true, "pause.eventRunId": true,
    "pause.eventRevision": true, "pause.eventPolicyHash": true, "pause.processedOnChain": true, "pause.pausedAtReceiptBlock": true,
  });
  // The verifier certifies only CRE-simulation proofs; a local rehearsal passes every other check.
  const failed = Object.entries(verified.checks).filter(([, ok]) => ok === false).map(([name]) => name);
  expect(failed).toEqual(["savedEvidence.creSimulationMode"]);

  // Restart recovery reads the same chain: the paused run landed, an unknown one did not.
  const landed = await findSubmittedPause(proof.pause.runId, deployment);
  expect(landed).toMatchObject({ landed: true, transactionHash: proof.pause.transactionHash, blockNumber: proof.pause.blockNumber });
  expect((await findSubmittedPause("run-never-submitted", deployment)).landed).toBe(false);
});

test.skipIf(!enabled)("the receiver binds the policy hash: tampering with the frozen graph is refused before submission", async () => {
  ethUsd = 2500;
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `tamper-${Date.now()}`, 9);
  const tampered = { ...spec, graph: composedPause(1_000_000, "ethereum-mainnet") };
  await expect(executeRehearsalRun(tampered as any, undefined, { deployment, fetchExchange, resolveFeed })).rejects.toThrow(/Policy hash does not match/);
  expect(await isPaused()).toBe(false);
});

test.skipIf(!enabled)("a pre-v2 receiver is refused before any report is sent", async () => {
  const legacy = await Bun.file("contracts/out/LegacyGrantVaultV1.sol/LegacyGrantVaultV1.json").json();
  const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode.object, args: [deployment.forwarder, 120n] }) });
  const old = { ...deployment, address: deployed.contractAddress! };
  const before = await client.getBlockNumber();
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `old-receiver-${Date.now()}`, 1);
  await expect(executeRehearsalRun(spec, undefined, { deployment: old, fetchExchange, resolveFeed })).rejects.toThrow(/accepts report v1, not v2/);
  expect(await client.getBlockNumber()).toBe(before);
});

test.skipIf(!enabled)("a pause that does not verify is diagnosed: wrong forwarder named, receiver revert decoded", async () => {
  const { diagnosePause } = await import("../cre/runner");
  const { encodePauseReport } = await import("../cre/graph");
  const { encodeFunctionData } = await import("viem");
  const forwarderArtifact = await Bun.file("contracts/out/LocalRehearsalForwarder.sol/LocalRehearsalForwarder.json").json();
  const rogue = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: forwarderArtifact.abi, bytecode: forwarderArtifact.bytecode.object, args: [] }) })).contractAddress!;
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `diagnose-${Date.now()}`, 4);
  const decidedAt = new Date().toISOString();
  const report = encodePauseReport({ target: deployment.address as Address, chainId: 31337, runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash as any, decidedAt: Math.floor(Date.parse(decidedAt) / 1000) });
  const hash = await wallet.sendTransaction({ to: rogue, gas: 300_000n, data: encodeFunctionData({ abi: forwarderArtifact.abi, functionName: "deliver", args: [deployment.address, report] }) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("reverted");
  // The diagnosis replays against the vault's real chain id, so check the local variant directly.
  const notes = await diagnosePause(client as any, deployment.address as Address, receipt as any, spec, { decidedAt } as any);
  const text = notes.join("\n");
  expect(text).toContain(`but the CRE transaction went to ${rogue}`);
  expect(text).toContain(`replaying this report from ${rogue} before that block reverts Unauthorized`);
  expect(await isPaused()).toBe(false);
});

test.skipIf(!enabled)("the vault pauses when delivered through Chainlink's MockKeystoneForwarder logic (CRE simulation path)", async () => {
  const { encodeReportFor } = await import("../cre/graph");
  const { concat, pad, toHex, keccak256, toBytes, encodeFunctionData, decodeEventLog } = await import("viem");
  const mock = await Bun.file("contracts/out/MockKeystoneForwarderCopy.sol/MockKeystoneForwarderCopy.json").json();
  const vaultArtifact = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").json();
  const forwarder = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: [] }) })).contractAddress!;
  const limits = { reserve: LOCAL_RESERVE, maxSweepBps: 10_000n, maxPaymentWei: 0n, minPaymentInterval: 0n, ccipRouter: "0x0000000000000000000000000000000000000000", ccipToken: "0x0000000000000000000000000000000000000000", ccipDestination: 0n, ccipReceiver: "0x0000000000000000000000000000000000000000", maxCcipFeeWei: 0n, minEvacuationInterval: 0n };
  const vault = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode.object, args: [forwarder, 300n, limits] }) })).contractAddress!;
  // Keystone metadata: version, execution id, timestamp, DON id, config version, workflow id, name, owner, report id = 109 bytes.
  const metadata = concat(["0x01", keccak256(toBytes("execution")), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), keccak256(toBytes("workflow")), pad(toHex("origins"), { size: 10, dir: "right" }), "0x000000000000000000000000000000000000beef", "0x0001"]);
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `mock-forwarder-${Date.now()}`, 2);
  const payload = encodeReportFor(3, { type: "pause-vault" }, { target: vault, chainId: 31337, runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash as any, decidedAt: Math.floor(Date.now() / 1000) });
  const hash = await wallet.sendTransaction({ to: forwarder, gas: 350_000n, data: encodeFunctionData({ abi: mock.abi, functionName: "report", args: [vault, concat([metadata, payload]), "0x", []] }) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const processed = receipt.logs.filter((log) => log.address.toLowerCase() === forwarder.toLowerCase()).map((log) => decodeEventLog({ abi: mock.abi, data: log.data, topics: log.topics }) as any);
  expect(processed[0].args.result).toBe(true);
  expect(await client.readContract({ address: vault, abi: vaultAbi, functionName: "paused" })).toBe(true);
  const { matchPauseEvent } = await import("../cre/runner");
  expect(matchPauseEvent(receipt.logs, vault, spec.runId, spec.revision, spec.policyHash)).toBe(true);
});

// ---- treasury actions on the real local chain: sweep, pay, evacuate, and the v2 vault already on Sepolia ----
const balanceOf = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ethBelow = (action: unknown, floor = 3000) => policyGraphSchema.parse({
  nodes: [{ id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } }, { id: "low", kind: "compare", input: "eth", op: "<", value: floor }],
  root: "low", action,
});
const run = (graph: unknown, tag: string, target = deployment) =>
  executeRehearsalRun(specOf(graph, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, 7), undefined, { deployment: target, fetchExchange, resolveFeed });

test.skipIf(!enabled)("sweep moves half the vault to the reserve and pauses, verified from the receiver's own event", async () => {
  ethUsd = 2500;
  if (await isPaused()) await resume();
  const [vaultBefore, reserveBefore] = await Promise.all([client.getBalance({ address: treasury.address }), client.getBalance({ address: LOCAL_RESERVE })]);
  const evidence = await run(ethBelow({ type: "sweep", fraction: 0.5 }), "sweep");
  expect(evidence.decision).toBe("act");
  const moved = BigInt(evidence.transaction!.effects!.sweptWei!);
  expect(moved).toBe(vaultBefore / 2n);
  expect(await client.getBalance({ address: LOCAL_RESERVE })).toBe(reserveBefore + moved);
  expect(evidence.transaction).toMatchObject({ status: "success", receiverConfirmed: true, pausedAfter: true, effects: { paused: true, reserve: LOCAL_RESERVE } });
  expect(await isPaused()).toBe(true);
  // A paused vault can still be swept; a payment is now refused by the guard before any report.
  const again = await run(ethBelow({ type: "sweep", fraction: 0.5, pause: false }), "sweep-paused");
  expect(BigInt(again.transaction!.effects!.sweptWei!)).toBe((vaultBefore - moved) / 2n);
  const blocked = await run(ethBelow({ type: "pay", payee: "grantee", amountEth: 0.01 }), "pay-paused");
  expect(blocked.decision).toBe("noop");
  expect(blocked.noopReason).toBe("Vault spending is paused; no payment is made.");
  expect(blocked.transaction).toBeUndefined();
  await resume();
});

test.skipIf(!enabled)("pay sends exactly the amount to the registered payee; an unknown payee is refused from the vault's own terms before anything is sent", async () => {
  ethUsd = 2500;
  const before = await client.getBalance({ address: LOCAL_PAYEES.grantee });
  const evidence = await run(ethBelow({ type: "pay", payee: "grantee", amountEth: 0.01 }), "pay");
  expect(evidence.transaction!.effects).toMatchObject({ paidWei: parseEther("0.01").toString(), payee: LOCAL_PAYEES.grantee });
  expect(await client.getBalance({ address: LOCAL_PAYEES.grantee })).toBe(before + parseEther("0.01"));
  const block = await client.getBlockNumber();
  const unknown = await run(ethBelow({ type: "pay", payee: "stranger", amountEth: 0.01 }), "pay-unknown");
  expect(unknown.noopReason).toBe('No payee named "stranger" is registered on the vault; the owner registers payees.');
  expect(unknown.vault!.terms).toMatchObject({ payee: "0x0000000000000000000000000000000000000000", maxPaymentWei: parseEther("0.05").toString() });
  expect(await client.getBlockNumber()).toBe(block);
  expect(await isPaused()).toBe(false);
});

test.skipIf(!enabled)("evacuate hands the vault's tokens to the CCIP router with the fee in ETH, and records the message ID", async () => {
  ethUsd = 2500;
  const tokens = await client.readContract({ address: treasury.ccipToken, abi: balanceOf, functionName: "balanceOf", args: [treasury.address] });
  expect(tokens).toBe(parseEther("2"));
  const evidence = await run(ethBelow({ type: "evacuate", destination: "base-sepolia", fraction: 1 }), "evacuate");
  expect(evidence.vault!.tokenBalance).toBe(parseEther("2").toString());
  const effects = evidence.transaction!.effects!;
  expect(effects).toMatchObject({ ccipAmount: parseEther("2").toString(), ccipFee: LOCAL_CCIP_FEE.toString(), destinationChainSelector: "10344971235874465080", paused: true });
  expect(effects.ccipMessageId).toMatch(/^0x[0-9a-f]{64}$/);
  expect(effects.ccipExplorerUrl).toBe(`https://ccip.chain.link/msg/${effects.ccipMessageId}`);
  expect(await client.readContract({ address: treasury.ccipToken, abi: balanceOf, functionName: "balanceOf", args: [treasury.ccipRouter] })).toBe(parseEther("2"));
  // Nothing left to bridge: the protective evacuation still pauses, and only the pause is sent.
  await resume();
  const empty = await run(ethBelow({ type: "evacuate", destination: "base-sepolia", fraction: 1 }), "evacuate-empty");
  expect(empty).toMatchObject({ decision: "act", effectiveAction: { type: "pause-vault" }, degradedReason: "Vault holds no CCIP-BnM to evacuate" });
  expect(empty.transaction).toMatchObject({ pausedAfter: true, effects: { paused: true } });
  expect(empty.transaction!.effects!.ccipMessageId).toBeUndefined();
  // Without a pause to send, the same empty vault is a plain no-op.
  await resume();
  const plain = await run(ethBelow({ type: "evacuate", destination: "base-sepolia", fraction: 1, pause: false }), "evacuate-empty-nopause");
  expect(plain.noopReason).toBe("Vault holds no CCIP-BnM to evacuate.");
});

test.skipIf(!enabled)("the v2 vault already on Sepolia still gets pause reports, and refuses new actions before anything is sent", async () => {
  ethUsd = 2500;
  const legacy = await Bun.file("contracts/out/LegacyGrantVaultV2.sol/LegacyGrantVaultV2.json").json();
  const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode.object, args: [deployment.forwarder, 120n], value: parseEther("0.1") }) });
  const v2 = { ...deployment, address: deployed.contractAddress! };
  const paused = await run(ethBelow({ type: "pause-vault" }), "v2-pause", v2);
  expect(paused.transaction).toMatchObject({ status: "success", receiverConfirmed: true, pausedAfter: true, effects: { paused: true } });
  const before = await client.getBlockNumber();
  await expect(run(ethBelow({ type: "sweep", fraction: 0.5 }), "v2-sweep", v2)).rejects.toThrow(/pause reports only \(v2\); a sweep needs a GrantVault v3/);
  expect(await client.getBlockNumber()).toBe(before);
});
