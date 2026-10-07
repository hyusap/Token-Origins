// Independently re-checks a proof file against the chain and the frozen graphs.
//   bun run scripts/verify-evidence.ts demo/sepolia-evidence-....json
import { createPublicClient, http, parseAbi, decodeEventLog, type Address, type Hex } from "viem";
import { policyHash, runIdHash, describeGraph } from "../cre/graph";
import { specificationSchema } from "../cre/spec";
import { Connection } from "@solana/web3.js";
import { parseVaultEvents, SOLANA_DEVNET_RPC } from "../cre/solana-vault";

const abi = parseAbi([
  "event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)",
  "event ReserveSwept(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,address reserve,uint256 amount)",
  "event GrantStreamed(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,bytes32 payeeId,address payee,uint256 amount)",
  "event TreasuryEvacuated(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,bytes32 messageId,uint64 destinationChainSelector,address token,uint256 amount,uint256 fee)",
  "function paused() view returns (bool)",
  "function processedRuns(bytes32) view returns (bool)",
  "function reserve() view returns (address)",
  "function payees(bytes32) view returns (address)",
  "function forwarder() view returns (address)",
]);
const defaultRpc = (chainId: number) =>
  chainId === 11155111 ? process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545";

export async function verifyEvidenceFile(path: string, rpcUrl?: string) {
  const proof = await Bun.file(path).json();
  if (proof.kind === "treasury-actions") return verifyActionsFile(proof, rpcUrl);
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
    checks[`${name}.policyHashRecomputed`] = policyHash(spec.graph, spec.maxAgeSeconds) === spec.policyHash && spec.policyHash === entry.evidence.policyHash;
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

/**
 * Re-checks a treasury-actions proof: every frozen graph still hashes to what
 * ran, and each receipt holds this vault's own event for that run, revision and
 * policy hash, moving what the evidence says to where the vault's config says.
 */
async function verifyActionsFile(proof: any, rpcUrl?: string) {
  const vault = proof.vault as Address;
  const client = createPublicClient({ transport: http(rpcUrl || proof.rpcUrl || defaultRpc(proof.chainId)) });
  if ((await client.getChainId()) !== proof.chainId) throw new Error(`RPC is not chain ${proof.chainId}`);
  const checks: Record<string, boolean | string> = {};
  const reserve = (await client.readContract({ address: vault, abi, functionName: "reserve" })).toLowerCase();
  for (const [name, entry] of Object.entries<any>(proof.cases)) {
    const spec = specificationSchema.parse(entry.spec);
    checks[`${name}.policyHashRecomputed`] = policyHash(spec.graph, spec.maxAgeSeconds) === spec.policyHash && spec.policyHash === entry.evidence.policyHash;
    const receipt = await client.getTransactionReceipt({ hash: entry.evidence.transaction.hash as Hex });
    checks[`${name}.receiptSuccess`] = receipt.status === "success";
    const events = receipt.logs
      .filter((log) => log.address.toLowerCase() === vault.toLowerCase())
      .map((log) => { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }) as any; } catch { return null; } })
      .filter((event) => event && event.args.runId === runIdHash(spec.runId) && event.args.revision === BigInt(spec.revision) && String(event.args.policyHash).toLowerCase() === spec.policyHash.toLowerCase());
    checks[`${name}.processedOnChain`] = await client.readContract({ address: vault, abi, functionName: "processedRuns", args: [runIdHash(spec.runId)] });
    const effects = entry.evidence.transaction.effects ?? {};
    const action = spec.graph.action;
    if (action.type === "sweep") {
      const swept = events.find((event) => event.eventName === "ReserveSwept");
      checks[`${name}.reserveSwept`] = Boolean(swept) && swept.args.amount.toString() === effects.sweptWei && String(swept.args.reserve).toLowerCase() === reserve;
    }
    if (action.type === "pay") {
      const paid = events.find((event) => event.eventName === "GrantStreamed");
      const payee = paid ? (await client.readContract({ address: vault, abi, functionName: "payees", args: [paid.args.payeeId] })).toLowerCase() : "";
      checks[`${name}.paidRegisteredPayee`] = Boolean(paid) && paid.args.amount.toString() === effects.paidWei && String(paid.args.payee).toLowerCase() === payee;
      // CRE proofs record which trigger ran; local rehearsals have no cron trigger to claim.
      if (proof.chainId === 11155111) checks[`${name}.ranThroughCronTrigger`] = entry.evidence.trigger === "cron";
    }
    if (action.type === "evacuate") {
      const sent = events.find((event) => event.eventName === "TreasuryEvacuated");
      checks[`${name}.ccipMessageSent`] = Boolean(sent) && sent.args.messageId === effects.ccipMessageId && sent.args.destinationChainSelector.toString() === effects.destinationChainSelector;
      checks[`${name}.pausedInSameReport`] = events.some((event) => event.eventName === "SpendingPaused") || effects.paused === true;
    }
    const leg = entry.evidence.solana;
    if (leg?.signature) {
      const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
      const tx = await connection.getTransaction(leg.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const solanaEvents = parseVaultEvents(tx?.meta?.logMessages ?? []);
      checks[`${name}.solanaSucceeded`] = Boolean(tx && !tx.meta?.err);
      checks[`${name}.solanaSamePolicyHash`] = solanaEvents.some((event) => "runId" in event && event.runId === runIdHash(spec.runId) && event.policyHash.toLowerCase() === spec.policyHash.toLowerCase());
    }
  }
  const failed = Object.entries(checks).filter(([, value]) => value !== true);
  return {
    verified: failed.length === 0,
    chainId: proof.chainId, vault,
    actions: Object.fromEntries(Object.entries<any>(proof.cases).map(([name, entry]) => [name, { policy: describeGraph(specificationSchema.parse(entry.spec).graph), transaction: entry.evidence.transaction.hash, ...(entry.evidence.transaction.effects?.ccipExplorerUrl ? { ccip: entry.evidence.transaction.effects.ccipExplorerUrl } : {}) }])),
    checks,
  };
}
