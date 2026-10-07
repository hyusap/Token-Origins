// Real local EVM: deploys the v2 vault on a throwaway Anvil node and runs the
// actual runner, receiver, proof sequence, independent verifier and restart
// reconciliation against it. Prices are injected (no network needed); every
// transaction, event and state read is real. Skips when Foundry is not
// installed or contracts are not built (forge build --root contracts).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createPublicClient, createWalletClient, http, defineChain, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCreRun, findSubmittedPause, type LocalDeployment } from "../cre/runner";
import { sourceIdentity, FEED_REGISTRY, type FeedSource, type Observation } from "../cre/graph";
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
let ethUsd = 2500;

async function startAnvil(extra: string[] = []) {
  const proc = Bun.spawn([anvil!, "--port", String(PORT), "--chain-id", "31337", "--silent", ...extra], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await client.getChainId(); return proc; } catch { await Bun.sleep(100); }
  }
  throw new Error("Anvil did not start");
}
async function deploy(): Promise<LocalDeployment> {
  const forwarder = await Bun.file("contracts/out/LocalRehearsalForwarder.sol/LocalRehearsalForwarder.json").json();
  const vault = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").json();
  const f = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: forwarder.abi, bytecode: forwarder.bytecode.object, args: [] }) });
  const v = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: vault.abi, bytecode: vault.bytecode.object, args: [f.contractAddress, 120n], value: parseEther("1") }) });
  return { address: v.contractAddress!, forwarder: f.contractAddress!, chainId: 31337, rpcUrl, blockNumber: Number(v.blockNumber) };
}
const fetchExchange = async (): Promise<Observation> => ({
  ...sourceIdentity({ type: "exchange-trade", pair: "ETH-USD" }), usd: ethUsd, raw: String(ethUsd),
  observedAt: new Date(Date.now() - 2000).toISOString(), fetchedAt: new Date().toISOString(),
});
const resolveFeed = async (source: FeedSource): Promise<Observation> => ({
  ...sourceIdentity(source), usd: 85000, raw: "8500000000000", roundId: "1",
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

test.skipIf(!enabled)("the deployed vault reports v2 and a stale clock is aligned without losing state", async () => {
  expect(await deployedReportVersion(rpcAt(rpcUrl), deployment.address)).toBe(2);
  expect(await deployedReportVersion(rpcAt(rpcUrl), "0x000000000000000000000000000000000000dEaD")).toBeNull();
  const aligned = await alignLocalClock(rpcAt(rpcUrl), () => Math.floor(Date.now() / 1000) + 3600);
  expect(aligned.minedAlignmentBlock).toBe(true);
  expect(Math.abs(aligned.lagAfter)).toBeLessThanOrEqual(5);
  expect(await deployedReportVersion(rpcAt(rpcUrl), deployment.address)).toBe(2);
  // Bring the chain back near real time for the runs below: later blocks follow the new offset.
  await rpcAt(rpcUrl)("evm_setTime", [Math.floor(Date.now() / 1000)]);
  await rpcAt(rpcUrl)("evm_mine", []);
});

test.skipIf(!enabled)("full local proof: false, verified composed pause, no duplicate, sell never writes; then independent verification", async () => {
  ethUsd = 2500;
  const execute = (spec: any) => executeCreRun(spec, undefined, { deployment, fetchExchange, resolveFeed });
  const proof = await proveSequence({ label: "anvil-integration", feedNetwork: "ethereum-mainnet", execute, isPaused, resume, log: () => {} });
  expect(proof.cases.trueCondition.evidence.transaction?.receiverConfirmed).toBe(true);
  expect(proof.cases.trueCondition.evidence.observations.map((o) => o.key)).toEqual(["exchange-trade:ETH-USD", "chainlink-feed:ethereum-mainnet:BTC"]);
  expect(proof.cases.trueCondition.evidence.observations[1]!.address).toBe(FEED_REGISTRY["ethereum-mainnet"].BTC!);
  expect(proof.cases.unsupportedAction.evidence?.simulatedOrder?.simulated).toBe(true);
  expect(await isPaused()).toBe(false);

  const dir = await mkdtemp(join(tmpdir(), "sotto-proof-"));
  const file = join(dir, "evidence.json");
  await Bun.write(file, JSON.stringify({ chainId: 31337, vault: deployment.address, rpcUrl, ...proof }));
  const verified = await verifyEvidenceFile(file);
  expect(verified.checks).toMatchObject({
    "trueCondition.policyHashRecomputed": true, "pause.receiptSuccess": true, "pause.eventRunId": true,
    "pause.eventRevision": true, "pause.eventPolicyHash": true, "pause.processedOnChain": true, "pause.pausedAtReceiptBlock": true,
  });
  expect(verified.verified).toBe(true);

  // Restart recovery reads the same chain: the paused run landed, an unknown one did not.
  const landed = await findSubmittedPause(proof.pause.runId, deployment);
  expect(landed).toMatchObject({ landed: true, transactionHash: proof.pause.transactionHash, blockNumber: proof.pause.blockNumber });
  expect((await findSubmittedPause("run-never-submitted", deployment)).landed).toBe(false);
});

test.skipIf(!enabled)("the receiver binds the policy hash: tampering with the frozen graph is refused before submission", async () => {
  ethUsd = 2500;
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `tamper-${Date.now()}`, 9);
  const tampered = { ...spec, graph: composedPause(1_000_000, "ethereum-mainnet") };
  await expect(executeCreRun(tampered as any, undefined, { deployment, fetchExchange, resolveFeed })).rejects.toThrow(/Policy hash does not match/);
  expect(await isPaused()).toBe(false);
});

test.skipIf(!enabled)("a pre-v2 receiver is refused before any report is sent", async () => {
  const legacy = await Bun.file("contracts/out/LegacyGrantVaultV1.sol/LegacyGrantVaultV1.json").json();
  const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode.object, args: [deployment.forwarder, 120n] }) });
  const old = { ...deployment, address: deployed.contractAddress! };
  const before = await client.getBlockNumber();
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `old-receiver-${Date.now()}`, 1);
  await expect(executeCreRun(spec, undefined, { deployment: old, fetchExchange, resolveFeed })).rejects.toThrow(/accepts report v1, not v2/);
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
  const { encodePauseReport } = await import("../cre/graph");
  const { concat, pad, toHex, keccak256, toBytes, encodeFunctionData, decodeEventLog } = await import("viem");
  const mock = await Bun.file("contracts/out/MockKeystoneForwarderCopy.sol/MockKeystoneForwarderCopy.json").json();
  const vaultArtifact = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").json();
  const forwarder = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: [] }) })).contractAddress!;
  const vault = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode.object, args: [forwarder, 300n] }) })).contractAddress!;
  // Keystone metadata: version, execution id, timestamp, DON id, config version, workflow id, name, owner, report id = 109 bytes.
  const metadata = concat(["0x01", keccak256(toBytes("execution")), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), keccak256(toBytes("workflow")), pad(toHex("origins"), { size: 10, dir: "right" }), "0x000000000000000000000000000000000000beef", "0x0001"]);
  const spec = specOf(composedPause(3000, "ethereum-mainnet"), `mock-forwarder-${Date.now()}`, 2);
  const payload = encodePauseReport({ target: vault, chainId: 31337, runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash as any, decidedAt: Math.floor(Date.now() / 1000) });
  const hash = await wallet.sendTransaction({ to: forwarder, gas: 350_000n, data: encodeFunctionData({ abi: mock.abi, functionName: "report", args: [vault, concat([metadata, payload]), "0x", []] }) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const processed = receipt.logs.filter((log) => log.address.toLowerCase() === forwarder.toLowerCase()).map((log) => decodeEventLog({ abi: mock.abi, data: log.data, topics: log.topics }) as any);
  expect(processed[0].args.result).toBe(true);
  expect(await client.readContract({ address: vault, abi: vaultAbi, functionName: "paused" })).toBe(true);
  const { matchPauseEvent } = await import("../cre/runner");
  expect(matchPauseEvent(receipt.logs, vault, spec.runId, spec.revision, spec.policyHash)).toBe(true);
});
