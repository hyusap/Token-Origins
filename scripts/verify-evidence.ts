// Independently re-checks a proof file against the chain and the frozen graphs.
//   bun run scripts/verify-evidence.ts demo/sepolia-evidence-....json
import { createPublicClient, http, parseAbi, decodeEventLog, type Address, type Hex } from "viem";
import { policyHash, runIdHash, describeGraph } from "../cre/graph";
import { specificationSchema } from "../cre/spec";

const abi = parseAbi([
  "event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)",
  "function paused() view returns (bool)",
  "function processedRuns(bytes32) view returns (bool)",
  "function forwarder() view returns (address)",
]);
const defaultRpc = (chainId: number) =>
  chainId === 11155111 ? process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545";

export async function verifyEvidenceFile(path: string, rpcUrl?: string) {
  const proof = await Bun.file(path).json();
  const chainId: number = proof.chainId;
  const vault = proof.vault as Address;
  const effectiveRpc = rpcUrl || proof.rpcUrl || defaultRpc(chainId);
  const client = createPublicClient({ transport: http(effectiveRpc) });
  if ((await client.getChainId()) !== chainId) throw new Error(`RPC is not chain ${chainId}`);
  const checks: Record<string, boolean | string> = {};
  const fail = (name: string, detail: string) => { checks[name] = `FAILED: ${detail}`; };

  // Each frozen graph still validates and still hashes to what was executed.
  for (const [name, entry] of Object.entries<any>({ falseCondition: proof.cases.falseCondition, trueCondition: proof.cases.trueCondition })) {
    const spec = specificationSchema.parse(entry.spec);
    checks[`${name}.policyHashRecomputed`] = policyHash(spec.graph) === spec.policyHash && spec.policyHash === entry.evidence.policyHash;
  }
  checks["falseCondition.noTransaction"] = !proof.cases.falseCondition.evidence.transaction;
  checks["savedEvidence.creSimulationMode"] = [proof.cases.falseCondition, proof.cases.trueCondition]
    .every(entry => entry.evidence.mode === "cre-local-simulation");

  const pause = proof.pause;
  const trueSpec = specificationSchema.parse(proof.cases.trueCondition.spec);
  checks["pause.savedSpecCorrelation"] = pause.runId === trueSpec.runId && pause.revision === trueSpec.revision && pause.policyHash === trueSpec.policyHash;
  checks["pause.savedTransactionCorrelation"] = proof.cases.trueCondition.evidence.transaction?.hash === pause.transactionHash;
  const receipt = await client.getTransactionReceipt({ hash: pause.transactionHash as Hex });
  checks["pause.receiptSuccess"] = receipt.status === "success";
  checks["pause.receiptBlockCorrelation"] = Number(receipt.blockNumber) === Number(pause.blockNumber);
  const trustedForwarder = await client.readContract({ address: vault, abi, functionName: "forwarder" });
  checks["pause.authorizedForwarderDestination"] = receipt.to?.toLowerCase() === trustedForwarder.toLowerCase();
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === vault.toLowerCase())
    .map((log) => { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; } })
    .find((decoded) => decoded?.eventName === "SpendingPaused" && decoded.args.runId === runIdHash(pause.runId));
  if (!event || event.eventName !== "SpendingPaused") fail("pause.receiverEvent", "no SpendingPaused event from the vault");
  else {
    checks["pause.eventRunId"] = event.args.runId === runIdHash(pause.runId);
    checks["pause.eventRevision"] = event.args.revision === BigInt(pause.revision);
    checks["pause.eventPolicyHash"] = event.args.policyHash.toLowerCase() === String(pause.policyHash).toLowerCase();
  }
  checks["pause.processedOnChain"] = await client.readContract({ address: vault, abi, functionName: "processedRuns", args: [runIdHash(pause.runId)] });
  try {
    checks["pause.pausedAtReceiptBlock"] = await client.readContract({ address: vault, abi, functionName: "paused", blockNumber: receipt.blockNumber });
  } catch {
    checks["pause.pausedAtReceiptBlock"] = "unavailable (RPC has no archive state); event and receipt verified instead";
  }
  checks["duplicate.noSecondTransaction"] = !proof.cases.duplicate.newRunOnPausedVault.evidence.transaction;
  const sell = proof.cases.unsupportedAction;
  checks["unsupportedAction.noTransaction"] = !sell.evidence?.transaction;
  checks["unsupportedAction.refused"] = typeof sell.refused === "string" && sell.refused.length > 0;
  checks["unsupportedAction.noSimulatedOrder"] = !sell.evidence?.simulatedOrder;
  const failed = Object.entries(checks).filter(([, value]) => value !== true && !(typeof value === "string" && value.startsWith("unavailable")));
  return {
    verified: failed.length === 0,
    chainId, vault,
    pausedPolicy: describeGraph(specificationSchema.parse(proof.cases.trueCondition.spec).graph),
    verifiedAt: new Date().toISOString(), independentReadOnly: true,
    rpcProvider: new URL(effectiveRpc).hostname,
    verificationScope: "Saved CRE simulation claim and frozen graphs correlated with actual public receipt/receiver event; this does not establish deployed DON execution or independently recreate historical off-chain source reads",
    trustedForwarder,
    transaction: pause.transactionHash, block: Number(receipt.blockNumber), blockHash: receipt.blockHash,
    checks,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun run scripts/verify-evidence.ts <evidence.json> [rpcUrl]");
  const result = await verifyEvidenceFile(path, process.argv[3]);
  if (process.argv[4]) await Bun.write(process.argv[4], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 1;
}
