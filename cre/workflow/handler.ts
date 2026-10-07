import { EVMClient, protoBigIntToBigint, HTTPClient, decodeJson, encodeCallMsg, bytesToHex, hexToBase64, LATEST_BLOCK_NUMBER, TxStatus, ConsensusAggregationByFields, median, SolanaClient, SolanaTxStatus, getNetwork, solanaAccountMeta, solanaAccountMetasToJson, calculateAccountsHash, encodeForwarderReport, prepareSolanaReportRequest, type HTTPSendRequester, type HTTPPayload, type CronPayload, type Runtime } from '@chainlink/cre-sdk';
import { PublicKey } from '@solana/web3.js';
import { encodeSolanaPauseReport, encodeSolanaActionReport } from '../solana-report';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { encodeFunctionData, decodeFunctionResult, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { specificationSchema, PRICE_URL, parsePrice } from '../spec';
import { evidenceChunks } from '../evidence-log';
import { readChainSourceSync, chainReadCost } from '../onchain-reads';
import {
  evaluateGraph, collectSources, sourceIdentity, describeSource, explainNoop, encodeReportFor, reportRefusal, actionTerms, actionPauses, isSimulatedAction, toBps,
  payeeId, termsFromTuple, vaultTermsAbi, NETWORKS, ACTION_SWEEP, ACTION_PAUSE, FLAG_PAUSE, ZERO_BYTES32, type Observation, type Reading, type VaultAction, type VaultTerms, type Source,
} from '../graph';

const VAULT_NETWORK = 'ethereum-sepolia' as const;
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const configSchema = z.object({
  vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainSelector: z.literal(NETWORKS[VAULT_NETWORK].chainSelector),
  gasLimit: z.string(),
  /** Optional second treasury: the sotto_vault program on Solana, steered by the same decision. */
  solana: z.object({
    chainSelectorName: z.literal('solana-devnet'),
    receiverProgramId: base58,
    forwarderProgramId: base58,
    forwarderState: base58,
    vault: base58,
    /** Present when the vault has a configured reserve (program v3): its treasury PDA and reserve account. */
    sweep: z.object({ treasury: base58, reserve: base58 }).strict().optional(),
  }).strict().optional(),
  /**
   * A standing policy: the cron trigger re-evaluates this frozen specification
   * on its schedule. The runner writes one per check with a fresh run ID.
   */
  watch: z.object({ schedule: z.string().min(1).max(64), spec: z.unknown() }).strict().optional(),
});
export type Config = z.infer<typeof configSchema>;
const vaultAbi = parseAbi(['function paused() view returns (bool)', 'function reportVersion() view returns (uint256)']);
/** CRE's per-execution EVM read quota. */
const READ_LIMIT = 15;

function fetchPrice(sender: HTTPSendRequester): { usd: number; observedAt: number } {
  const reply = sender.sendRequest({ url: PRICE_URL, method: 'GET', headers: { Accept: 'application/json' } }).result();
  if (reply.statusCode !== 200) throw new Error(`Price source returned ${reply.statusCode}`);
  const price = parsePrice(JSON.parse(new TextDecoder().decode(reply.body)));
  return { usd: price.usd, observedAt: Date.parse(price.observedAt) };
}

/** HTTP trigger: one execution of the frozen specification in the request. */
export function onHttp(runtime: Runtime<Config>, payload: HTTPPayload): string {
  return runPolicy(runtime, decodeJson(payload.input), 'http');
}
/** Cron trigger: one check of the standing policy in the workflow config. */
export function onCron(runtime: Runtime<Config>, _payload: CronPayload): string {
  const watch = runtime.config.watch;
  if (!watch) throw new Error('No standing policy is configured for this cron trigger');
  return runPolicy(runtime, watch.spec, 'cron');
}

/**
 * The CRE side of the shared decision path in cre/runner.ts. Inputs are read
 * through DON capabilities; evaluation, guards and the report layout come from
 * cre/graph.ts. Reads: up to 4 vault calls (version, paused, balance, and
 * terms() for a payment or evacuation) plus at most 2 per source
 * (≤ MAX_SOURCES), inside the 15-read quota.
 */
function runPolicy(runtime: Runtime<Config>, input: unknown, trigger: 'http' | 'cron'): string {
  // Full validation: shape, cycles, connectivity, units, registries, and policy hash.
  const spec = specificationSchema.parse(input);
  const graph = spec.graph;
  // Simulated actions stop here, before any read or write.
  if (isSimulatedAction(graph.action))
    throw new Error('Simulated sells run only in local rehearsal (as do simulated rebalances); CRE delivers only real vault actions. Nothing was submitted.');
  const action = graph.action as VaultAction;

  const clients = new Map<string, EVMClient>();
  const clientFor = (selector: string) => {
    let client = clients.get(selector);
    if (!client) clients.set(selector, (client = new EVMClient(BigInt(selector))));
    return client;
  };
  let reads = 0;
  const call = (selector: string, to: Address, data: Hex): Hex => {
    if (++reads > READ_LIMIT) throw new Error(`This policy needs more than ${READ_LIMIT} contract reads`);
    return bytesToHex(clientFor(selector).callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: LATEST_BLOCK_NUMBER }).result().data);
  };

  const vaultAddress = runtime.config.vaultAddress as Address;
  const vaultSelector = runtime.config.chainSelector;
  const vaultChainId = NETWORKS[VAULT_NETWORK].chainId;
  const vaultCall = (functionName: 'paused' | 'reportVersion') =>
    call(vaultSelector, vaultAddress, encodeFunctionData({ abi: vaultAbi, functionName }));
  let reportVersion: number | null = null;
  try {
    reportVersion = Number(decodeFunctionResult({ abi: vaultAbi, functionName: 'reportVersion', data: vaultCall('reportVersion') }));
  } catch {
    reportVersion = null;
  }
  // A vault that cannot take this action is refused before any other read.
  const refusal = reportRefusal(reportVersion, action.type);
  if (refusal) throw new Error(`Vault ${vaultAddress}: ${refusal}`);
  const paused = decodeFunctionResult({ abi: vaultAbi, functionName: 'paused', data: vaultCall('paused') });
  reads++;
  const balance = clientFor(vaultSelector).balanceAt(runtime, { account: vaultAddress, blockNumber: LATEST_BLOCK_NUMBER }).result();
  const balanceWei = balance.balance ? protoBigIntToBigint(balance.balance) : 0n;
  // One read of everything the vault will check before it pays or bridges.
  let terms: VaultTerms | undefined;
  if (action.type === 'pay' || action.type === 'evacuate') {
    const args = [action.type === 'pay' ? payeeId(action.payee) : ZERO_BYTES32] as const;
    terms = termsFromTuple(decodeFunctionResult({ abi: vaultTermsAbi, functionName: 'terms', data: call(vaultSelector, vaultAddress, encodeFunctionData({ abi: vaultTermsAbi, functionName: 'terms', args })) }));
  }

  const fetchedAt = runtime.now().toISOString();
  const observations: Observation[] = [];
  for (const source of collectSources(graph) as Source[]) {
    const identity = sourceIdentity(source);
    runtime.log(`ORIGINS_SOURCE Reading ${describeSource(source)}${identity.address ? ` at ${identity.address}` : ''}`);
    if (source.type === 'exchange-trade') {
      const trade = new HTTPClient().sendRequest(runtime, fetchPrice, ConsensusAggregationByFields<{ usd: number; observedAt: number }>({ usd: median<number>, observedAt: median<number> }))().result();
      observations.push({ ...identity, value: trade.usd, usd: trade.usd, raw: String(trade.usd), observedAt: new Date(trade.observedAt).toISOString(), fetchedAt });
    } else if (source.type === 'vault-balance') {
      const eth = Number(balanceWei) / 1e18;
      observations.push({ ...identity, value: eth, raw: balanceWei.toString(), observedAt: fetchedAt, fetchedAt });
    } else {
      if (reads + chainReadCost(source) > READ_LIMIT) throw new Error(`This policy needs more than ${READ_LIMIT} contract reads`);
      const reading = readChainSourceSync(source, (c) => call(NETWORKS[c.network].chainSelector, c.to, c.data));
      observations.push({
        ...identity, value: reading.value, ...(identity.unit === 'USD' ? { usd: reading.value } : {}), raw: reading.raw,
        ...(reading.roundId ? { roundId: reading.roundId } : {}),
        observedAt: reading.updatedAt ? new Date(reading.updatedAt * 1000).toISOString() : fetchedAt, fetchedAt,
      });
    }
  }
  const readings: Record<string, Reading> = Object.fromEntries(observations.map((o) => [o.key, { value: o.value, observedAt: o.observedAt }]));
  const nowMs = runtime.now().getTime();
  const result = evaluateGraph(graph, {
    readings, vaultPaused: paused, vaultBalanceWei: balanceWei, vaultTerms: terms ?? null,
    exchangeMaxAgeSeconds: spec.maxAgeSeconds,
  }, nowMs);
  // What is actually sent: the action as written, or only its pause when nothing can move.
  const sent = result.effectiveAction ?? action;
  const evidence: any = {
    runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash, mode: 'cre-local-simulation', trigger, observations,
    vault: { address: vaultAddress, chainId: vaultChainId, paused, balanceWei: balanceWei.toString(), reportVersion, ...(terms ? { terms, tokenBalance: terms.tokenBalance } : {}) },
    conditions: result.conditions, root: result.root, decision: result.decision, action: action.type, decidedAt: new Date(nowMs).toISOString(), logs: [],
    ...(result.effectiveAction ? { effectiveAction: result.effectiveAction, degradedReason: result.degradedBy?.detail } : {}),
  };
  if (result.decision === 'noop') evidence.noopReason = explainNoop(result);
  if (result.decision === 'act' && spec.broadcast === false) evidence.dryRun = true;
  if (result.decision === 'act' && spec.broadcast !== false) {
    const reportTerms = actionTerms(sent);
    const encoded = encodeReportFor(reportVersion, sent, { target: vaultAddress, chainId: vaultChainId, runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash as Hex, decidedAt: Math.floor(nowMs / 1000) });
    evidence.report = { version: reportVersion, action: reportTerms.action, flags: reportTerms.flags, payeeId: reportTerms.payeeId, amount: reportTerms.amount.toString(), destinationChainSelector: reportTerms.destinationChainSelector.toString() };
    const report = runtime.report({ encodedPayload: hexToBase64(encoded), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();
    const tx = clientFor(vaultSelector).writeReport(runtime, { receiver: vaultAddress, report, gasConfig: { gasLimit: runtime.config.gasLimit } }).result();
    const receiverConfirmed = tx.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.SUCCESS;
    evidence.transaction = { hash: tx.txHash ? bytesToHex(tx.txHash) : null, status: tx.txStatus === TxStatus.SUCCESS ? 'success' : 'failed', receiverConfirmed };
    if (tx.txStatus !== TxStatus.SUCCESS || !receiverConfirmed) throw new Error(`Report did not execute successfully: ${tx.errorMessage || tx.receiverContractExecutionStatus}`);
    // The same decision lands on Solana: one run, one policy hash, two treasuries.
    const solana = runtime.config.solana;
    if (solana) {
      const plan = solanaPlan(sent, solana);
      if (plan.write) evidence.solana = writeSolanaReport(runtime, solana, plan, spec.runId, spec.revision, spec.policyHash as Hex, Math.floor(nowMs / 1000));
      else evidence.solanaSkipped = plan.reason;
    }
  }
  const json = JSON.stringify(evidence);
  for (const chunk of evidenceChunks(json)) runtime.log(chunk);
  return json;
}

type SolanaConfig = NonNullable<Config['solana']>;
type SolanaPlan = { write: true; action: number; flags: number; bps: number; sweep: boolean } | { write: false; reason: string };
/** What the Solana vault does for this action: pause, sweep its SOL to its reserve, or nothing. */
export function solanaPlan(action: VaultAction, config: SolanaConfig): SolanaPlan {
  if (action.type === 'sweep') {
    if (config.sweep) return { write: true, action: ACTION_SWEEP, flags: action.pause ? FLAG_PAUSE : 0, bps: toBps(action.fraction), sweep: true };
    if (action.pause) return { write: true, action: ACTION_PAUSE, flags: 0, bps: 0, sweep: false };
    return { write: false, reason: 'The Solana vault has no reserve configured (program v3 configure_reserve), so it was not swept' };
  }
  if (actionPauses(action)) return { write: true, action: ACTION_PAUSE, flags: 0, bps: 0, sweep: false };
  return { write: false, reason: `${action.type === 'pay' ? 'Payments' : 'Actions of this kind'} settle on Ethereum only; the Solana vault is unchanged` };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 for transaction signatures (64 bytes), which PublicKey cannot encode. */
function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) { out = BASE58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}

/**
 * Writes the decision to the sotto_vault program through the keystone
 * forwarder: accounts are [forwarder state, forwarder authority PDA, vault]
 * plus, for a sweep, [treasury config, reserve], hashed into the report so the
 * forwarder delivers exactly these. A plain pause uses the v2 layout every
 * program version accepts. Failures are recorded, not thrown, so the EVM
 * evidence above is never lost; the runner refuses to confirm a run whose
 * Solana write did not verify.
 */
function writeSolanaReport(runtime: Runtime<Config>, config: SolanaConfig, plan: Extract<SolanaPlan, { write: true }>, runId: string, revision: number, policyHash: Hex, decidedAt: number) {
  const network = getNetwork({ chainFamily: 'solana', chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Unknown Solana network ${config.chainSelectorName}`);
  const program = new PublicKey(config.receiverProgramId);
  const state = new PublicKey(config.forwarderState);
  const [authority] = PublicKey.findProgramAddressSync([new TextEncoder().encode('forwarder'), state.toBytes(), program.toBytes()], new PublicKey(config.forwarderProgramId));
  const accounts = [solanaAccountMeta(config.forwarderState, true), solanaAccountMeta(authority.toBase58()), solanaAccountMeta(config.vault, true)];
  if (plan.sweep && config.sweep) accounts.push(solanaAccountMeta(config.sweep.treasury), solanaAccountMeta(config.sweep.reserve, true));
  const vault = new PublicKey(config.vault).toBytes();
  const payload = plan.sweep
    ? encodeSolanaActionReport({ vault, runId, revision, policyHash, decidedAt, action: plan.action, flags: plan.flags, bps: plan.bps })
    : encodeSolanaPauseReport({ vault, runId, revision, policyHash, decidedAt });
  runtime.log(`ORIGINS_SOLANA Writing ${plan.sweep ? `a ${plan.bps / 100}% reserve sweep${plan.flags & FLAG_PAUSE ? ' and pause' : ''}` : 'pause'} for run ${runId} to vault ${config.vault} on ${config.chainSelectorName}`);
  const report = runtime.report(prepareSolanaReportRequest(encodeForwarderReport({ accountHash: calculateAccountsHash(accounts), payload }))).result();
  const reply = new SolanaClient(network.chainSelector.selector).writeReport(runtime, {
    remainingAccounts: solanaAccountMetasToJson(accounts),
    receiver: bytesToHex(program.toBytes()),
    computeConfig: { computeLimit: 290_000 },
    report,
  }).result();
  const signature = reply.txSignature && reply.txSignature.length ? toBase58(reply.txSignature) : null;
  return {
    network: config.chainSelectorName, programId: config.receiverProgramId, vault: config.vault, forwarderProgram: config.forwarderProgramId,
    action: plan.sweep ? 'sweep' : 'pause', pauses: plan.action === ACTION_PAUSE || Boolean(plan.flags & FLAG_PAUSE), ...(plan.sweep && config.sweep ? { reserve: config.sweep.reserve, bps: plan.bps } : {}),
    signature, status: reply.txStatus === SolanaTxStatus.SUCCESS ? 'success' : 'failed', ...(reply.errorMessage ? { error: reply.errorMessage } : {}),
  };
}
