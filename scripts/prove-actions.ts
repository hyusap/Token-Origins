// Records the treasury actions with real CRE simulation broadcasts, then verifies them independently:
//   1/3 sweep 25% of the vault to the reserve (HTTP trigger); the Solana vault sweeps too when its reserve is configured
//   2/3 pay the grantee 0.001 ETH through the workflow's cron trigger (one standing-policy check)
//   3/3 bridge the vault's CCIP-BnM to the reserve on Base Sepolia through Chainlink CCIP, pausing spending
// then resumes the vault for the next demo.
//   bun run prove:actions
// Needs: `cre login`, CRE_ETH_PRIVATE_KEY (the Sepolia wallet that deployed the v3 vault),
// ORIGINS_SEPOLIA_VAULT (from bun run deploy:sepolia). Optional ORIGINS_SOLANA_VAULT.
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { executeCreRun, cronEvery, type ExecutionEvidence } from "../cre/runner";
import { policyGraphSchema, describeGraph, REPORT_VERSION, type PolicyGraph } from "../cre/graph";
import { specOf } from "./prove-execution";
import { verifyEvidenceFile } from "./verify-evidence";
import { solanaLeg } from "./solana-proof";

process.env.ORIGINS_EXECUTION_MODE = "cre";
const vault = process.env.ORIGINS_SEPOLIA_VAULT as Address | undefined;
const key = process.env.CRE_ETH_PRIVATE_KEY as Hex | undefined;
if (!vault) throw new Error("Set ORIGINS_SEPOLIA_VAULT (printed by bun run deploy:sepolia)");
if (!key) throw new Error("Set CRE_ETH_PRIVATE_KEY (the funded Sepolia wallet that owns the vault)");
const rpcUrl = process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: sepolia, transport: http(rpcUrl) });
const abi = parseAbi(["function paused() view returns (bool)", "function resume()", "function owner() view returns (address)", "function reportVersion() view returns (uint256)"]);
if (Number(await client.readContract({ address: vault, abi, functionName: "reportVersion" }).catch(() => 0n)) !== REPORT_VERSION)
  throw new Error(`ORIGINS_SEPOLIA_VAULT is not a GrantVault v${REPORT_VERSION}; deploy one with bun run deploy:sepolia and update .env`);
if ((await client.readContract({ address: vault, abi, functionName: "owner" })).toLowerCase() !== wallet.account.address.toLowerCase())
  throw new Error("CRE_ETH_PRIVATE_KEY is not the vault owner, so the proof could not resume the vault afterwards");
const resume = async () => {
  if (!(await client.readContract({ address: vault, abi, functionName: "paused" }))) return undefined;
  const hash = await wallet.writeContract({ address: vault, abi, functionName: "resume" });
  await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return hash;
};
const solana = await solanaLeg();
let last: ExecutionEvidence | undefined;
const check = (condition: unknown, message: string) => {
  if (condition) return;
  // Say what the run actually did, so a failure is diagnosable without rerunning.
  const e = last;
  const detail = e ? [`decision ${e.decision}`, e.noopReason && `reason: ${e.noopReason}`, e.dryRun && "dry run",
    e.effectiveAction && `only ${e.effectiveAction.type} was sent (${e.degradedReason})`,
    `transaction ${e.transaction ? JSON.stringify(e.transaction) : "none"}`,
    ...e.conditions.filter((c) => !c.passed).map((c) => `failed ${c.nodeId}: ${c.detail}`)].filter(Boolean).join("\n  ") : "no evidence";
  throw new Error(`Proof failed: ${message}\n  ${detail}\n  CLI transcript: .data/cre-last-run.log`);
};
// Always true while the Chainlink ETH/USD feed is live: these cases prove the actions, not the condition
// (bun run prove:sepolia already recorded false, true, duplicate and refused cases).
const whenEthLive = (action: unknown): PolicyGraph => policyGraphSchema.parse({
  nodes: [{ id: "eth", kind: "price", source: { type: "chainlink-feed", symbol: "ETH" } }, { id: "live", kind: "compare", input: "eth", op: ">", value: 1 }],
  root: "live", action,
});
const suffix = Date.now().toString(36);
const startedAt = new Date().toISOString();
const log = (message: string) => console.log(`  ${message}`);
if (await resume()) console.log("Vault was paused; resumed first.");
if (solana && (await solana.isPaused())) await solana.resume();

console.log("1/3 Sweep 25% of the vault to the reserve (HTTP trigger)");
const sweepSpec = specOf(whenEthLive({ type: "sweep", fraction: 0.25, pause: false }), `prove-sweep-${suffix}`, 1);
const sweep = (last = await executeCreRun(sweepSpec, log));
check(sweep.transaction?.effects?.sweptWei && BigInt(sweep.transaction.effects.sweptWei) > 0n, "the sweep must emit ReserveSwept for this run");

console.log("2/3 Pay the grantee 0.001 ETH through the workflow's cron trigger");
const paySpec = specOf(whenEthLive({ type: "pay", payee: "grantee", amountEth: 0.001 }), `prove-pay-${suffix}`, 2);
const pay = (last = await executeCreRun(paySpec, log, { trigger: "cron", schedule: cronEvery(60) }));
check(pay.trigger === "cron", "the payment must run through the cron trigger");
check(pay.transaction?.effects?.paidWei === "1000000000000000", "the payment must emit GrantStreamed for 0.001 ETH");

console.log("3/3 Bridge the vault's CCIP-BnM to the reserve on Base Sepolia via CCIP, pausing spending");
const evacuateSpec = specOf(whenEthLive({ type: "evacuate", destination: "base-sepolia", fraction: 1, pause: true }), `prove-evacuate-${suffix}`, 3);
const evacuate = (last = await executeCreRun(evacuateSpec, log));
check(evacuate.transaction?.effects?.ccipMessageId && evacuate.transaction.pausedAfter, "the evacuation must emit TreasuryEvacuated with a CCIP message ID and pause");
console.log(`  CCIP message: ${evacuate.transaction!.effects!.ccipExplorerUrl} (delivery to Base Sepolia takes about 20 minutes)`);

const resumed = [await resume(), solana && (await solana.isPaused()) ? await solana.resume() : undefined].filter(Boolean);
const summarize = (spec: ReturnType<typeof specOf>, evidence: ExecutionEvidence) => ({ policy: describeGraph(spec.graph), spec, evidence });
const file = `demo/actions-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(file, JSON.stringify({
  kind: "treasury-actions",
  claim: "CRE local simulation with real Sepolia broadcasts through the CRE MockForwarder: a reserve sweep, a payment through the cron trigger, and a CCIP evacuation to Base Sepolia" + (solana ? ", with the Solana vault steered by the same decisions" : "") + ". Not deployed-DON execution.",
  chainId: 11155111, vault, rpcUrl, startedAt, completedAt: new Date().toISOString(), ...(solana ? { solana: solana.deployment } : {}),
  cases: { sweep: summarize(sweepSpec, sweep), pay: summarize(paySpec, pay), evacuate: summarize(evacuateSpec, evacuate) },
  resumeTransactionHashes: resumed,
}, null, 2));
console.log(`\nEvidence written to ${file}. Verifying independently from chain data…`);
const verified = await verifyEvidenceFile(file);
console.log(JSON.stringify(verified, null, 2));
if (!verified.verified) process.exitCode = 1;
