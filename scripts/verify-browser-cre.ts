// Read-only correlation of the actual browser/operator run with public chain data.
import {createPublicClient, http, parseAbi, decodeEventLog, type Address, type Hex} from "viem";
import {policyHash, runIdHash} from "../cre/graph";

const base = process.argv[2] || "http://127.0.0.1:4328";
const runId = process.argv[3];
const deadline = Date.now() + 120_000;
let state: any, run: any;
do {
  state = await (await fetch(`${base}/api/state`)).json();
  run = runId ? state.runs.find((r: any) => r.id === runId) : state.runs[0];
  if (run && !run.uncertain && ["confirmed", "failed", "no-op"].includes(run.status)) break;
  await Bun.sleep(1000);
} while (Date.now() < deadline);
if (!run || run.status !== "confirmed") throw new Error(`Browser run is not confirmed: ${run?.status || "missing"}; ${run?.error || ""}`);
const abi = parseAbi([
  "function paused() view returns (bool)",
  "function processedRuns(bytes32) view returns (bool)",
  "function forwarder() view returns (address)",
  "event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)",
]);
const client = createPublicClient({transport: http("https://sepolia.gateway.tenderly.co")});
const vault = run.target.address as Address;
const hash = run.evidence.transactionHash as Hex;
const receipt = await client.getTransactionReceipt({hash});
const forwarder = await client.readContract({address: vault, abi, functionName: "forwarder"});
const event = receipt.logs.filter(l => l.address.toLowerCase() === vault.toLowerCase()).map(l => {
  try {return decodeEventLog({abi, data: l.data, topics: l.topics});} catch {return null;}
}).find(e => e?.eventName === "SpendingPaused" && e.args.runId === runIdHash(run.id));
const checks = {
  chainIsSepolia: await client.getChainId() === 11155111,
  frozenReceiverIsSepolia: run.target.chainId === 11155111,
  frozenAuthorityIsCre: run.target.executor === "cre",
  executionIsCre: run.executionMode.includes("CRE local simulation"),
  broadcastWasPermitted: run.evaluationOnly === false,
  policyHashRecomputed: policyHash(run.snapshot.graph) === run.policyHash,
  receiptSuccess: receipt.status === "success",
  receiptBlockMatches: String(receipt.blockNumber) === run.evidence.blockNumber,
  authorizedForwarder: receipt.to?.toLowerCase() === forwarder.toLowerCase(),
  receiverEventRun: event?.eventName === "SpendingPaused" && event.args.runId === runIdHash(run.id),
  receiverEventRevision: event?.eventName === "SpendingPaused" && event.args.revision === BigInt(run.revision),
  receiverEventPolicyHash: event?.eventName === "SpendingPaused" && event.args.policyHash === run.policyHash,
  processedOnChain: await client.readContract({address: vault, abi, functionName: "processedRuns", args: [runIdHash(run.id)]}),
  pausedAtReceiptBlock: await client.readContract({address: vault, abi, functionName: "paused", blockNumber: receipt.blockNumber}),
  noMonitorsActivated: !state.monitors?.some((m: any) => ["active", "checking"].includes(m.status)),
};
const verified = Object.values(checks).every(Boolean);
const operator = await (await fetch(`${base}/api/rehearsal/status`)).json();
const proof = {verified, verifiedAt: new Date().toISOString(), independentReadOnly: true,
  rpcProvider: "sepolia.gateway.tenderly.co", claim: "Actual browser typed instruction → Codex operator → semantic MCP → CRE local simulation → public Sepolia report delivery; not deployed DON execution.",
  chainId: 11155111, vault, transactionHash: hash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
  checks, run,
  typedInstructions: state.conversation.filter((c: any) => c.role === "user").map((c: any) => ({text: c.text, at: c.at, source: c.source})),
  semanticTrace: state.latency.filter((l: any) => !["set_activity", "submit_utterance"].includes(l.tool)),
  operator: {busy: operator.busy, error: operator.error, turns: operator.turns}};
await Bun.write("demo/browser-cre-broadcast-verification.json", JSON.stringify(proof, null, 2));
console.log(JSON.stringify({verified, transactionHash: hash, block: String(receipt.blockNumber), checks}, null, 2));
if (!verified) process.exitCode = 1;
