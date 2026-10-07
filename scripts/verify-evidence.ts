// Independently re-checks a proof file against the chain and the frozen graphs.
//   bun run scripts/verify-evidence.ts demo/sepolia-evidence-....json
import { createPublicClient, http, parseAbi, decodeEventLog, type Address, type Hex } from "viem";
import { policyHash, runIdHash, describeGraph } from "../cre/graph";
import { specificationSchema } from "../cre/spec";
import { Connection } from "@solana/web3.js";
import { parseVaultEvents, SOLANA_DEVNET_RPC } from "../cre/solana-vault";

const abi = parseAbi([
  "event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)",
  "function paused() view returns (bool)",
  "function processedRuns(bytes32) view returns (bool)",
]);
const defaultRpc = (chainId: number) =>
  chainId === 11155111 ? process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545";

export async function verifyEvidenceFile(path: string, rpcUrl?: string) {
  const proof = await Bun.file(path).json();
  const chainId: number = proof.chainId;
  const vault = proof.vault as Address;
  const client = createPublicClient({ transport: http(rpcUrl || proof.rpcUrl || defaultRpc(chainId)) });
  if ((await client.getChainId()) !== chainId) throw new Error(`RPC is not chain ${chainId}`);
  const checks: Record<string, boolean | string> = {};
  const fail = (name: string, detail: string) => { checks[name] = `FAILED: ${detail}`; };

  // Each frozen graph still validates and still hashes to what was executed.
  for (const [name, entry] of Object.entries<any>({ falseCondition: proof.cases.falseCondition, trueCondition: proof.cases.trueCondition })) {
    const spec = specificationSchema.parse(entry.spec);
    checks[`${name}.policyHashRecomputed`] = policyHash(spec.graph, spec.maxAgeSeconds) === spec.policyHash && spec.policyHash === entry.evidence.policyHash;
  }
  checks["falseCondition.noTransaction"] = !proof.cases.falseCondition.evidence.transaction;

  const pause = proof.pause;
  const receipt = await client.getTransactionReceipt({ hash: pause.transactionHash as Hex });
  checks["pause.receiptSuccess"] = receipt.status === "success";
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === vault.toLowerCase())
    .map((log) => { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; } })
    .find((decoded) => decoded?.eventName === "SpendingPaused");
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
  // Solana half: the same decision, run and policy hash on the Solana vault, plus the grant beats.
  const leg = proof.cases.trueCondition.evidence.solana;
  if (proof.solana || leg) {
    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
    const tx = leg?.signature ? await connection.getTransaction(leg.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }) : null;
    checks["solana.transactionSucceeded"] = Boolean(tx && !tx.meta?.err);
    const event = parseVaultEvents(tx?.meta?.logMessages ?? []).find((e) => e.name === "SpendingPaused");
    checks["solana.eventVault"] = event?.name === "SpendingPaused" && event.vault === leg?.vault;
    checks["solana.eventRunId"] = event?.name === "SpendingPaused" && event.runId === runIdHash(pause.runId);
    checks["solana.eventRevision"] = event?.name === "SpendingPaused" && event.revision === pause.revision;
    checks["solana.eventPolicyHashMatchesEthereum"] = event?.name === "SpendingPaused" && event.policyHash.toLowerCase() === String(pause.policyHash).toLowerCase();
    const paid = proof.extras?.beforePause?.solanaGrantPaid?.signature;
    const paidTx = paid ? await connection.getTransaction(paid, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }) : null;
    checks["solana.grantPaidWhileActive"] = Boolean(paidTx && !paidTx.meta?.err && parseVaultEvents(paidTx.meta?.logMessages ?? []).some((e) => e.name === "GrantPaid"));
    checks["solana.grantRefusedWhilePaused"] = proof.extras?.afterPause?.solanaGrantRefused?.error === "SpendingIsPaused";
  }
  const failed = Object.entries(checks).filter(([, value]) => value !== true && !(typeof value === "string" && value.startsWith("unavailable")));
  return {
    verified: failed.length === 0,
    chainId, vault,
    pausedPolicy: describeGraph(specificationSchema.parse(proof.cases.trueCondition.spec).graph),
    transaction: pause.transactionHash, block: Number(receipt.blockNumber),
    checks,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun run scripts/verify-evidence.ts <evidence.json> [rpcUrl]");
  const result = await verifyEvidenceFile(path, process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 1;
}
