import { EVMClient, protoBigIntToBigint, HTTPClient, decodeJson, encodeCallMsg, bytesToHex, hexToBase64, LATEST_BLOCK_NUMBER, TxStatus, ConsensusAggregationByFields, median, type HTTPSendRequester, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { encodeFunctionData, decodeFunctionResult, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { specificationSchema, PRICE_URL, priceUrl, parsePrice } from '../spec';
import { evidenceChunks } from '../evidence-log';
import {
  evaluateGraph, collectSources, sourceKey, sourceIdentity, describeSource, explainNoop, encodePauseReport,
  NETWORKS, REPORT_VERSION, FEED_DECIMALS, type Observation, type PriceReading,
} from '../graph';

const VAULT_NETWORK = 'ethereum-sepolia' as const;
export const configSchema = z.object({
  vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainSelector: z.literal(NETWORKS[VAULT_NETWORK].chainSelector),
  gasLimit: z.string(),
});
export type Config = z.infer<typeof configSchema>;
const vaultAbi = parseAbi(['function paused() view returns (bool)', 'function reportVersion() view returns (uint256)']);
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);

function fetchPrice(sender: HTTPSendRequester, url = PRICE_URL): { usd: number; observedAt: number } {
  const reply = sender.sendRequest({ url, method: 'GET', headers: { Accept: 'application/json' } }).result();
  if (reply.statusCode !== 200) throw new Error(`Price source returned ${reply.statusCode}`);
  const price = parsePrice(JSON.parse(new TextDecoder().decode(reply.body)),url);
  return { usd: price.usd, observedAt: Date.parse(price.observedAt) };
}

/**
 * The CRE side of the shared decision path in cre/runner.ts. Inputs are read
 * through DON capabilities; evaluation, guards and the report layout come from
 * cre/graph.ts. Reads: 3 vault calls + 1 per feed (≤ MAX_SOURCES), within the
 * 10-read quota.
 */
export function onHttp(runtime: Runtime<Config>, payload: HTTPPayload): string {
  // Full validation: shape, cycles, connectivity, feed registry, and policy hash.
  const spec = specificationSchema.parse(decodeJson(payload.input));
  const graph = spec.graph;
  // Unsupported actions stop here, before any read or write.
  if (graph.action.type !== 'pause-vault')
    throw new Error('Unsupported action; CRE delivers pause-vault reports only. Nothing was submitted.');

  const clients = new Map<string, EVMClient>();
  const clientFor = (selector: string) => {
    let client = clients.get(selector);
    if (!client) clients.set(selector, (client = new EVMClient(BigInt(selector))));
    return client;
  };
  const call = (selector: string, to: Address, data: Hex) =>
    clientFor(selector).callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: LATEST_BLOCK_NUMBER }).result();

  const vaultAddress = runtime.config.vaultAddress as Address;
  const vaultSelector = runtime.config.chainSelector;
  const vaultChainId = NETWORKS[VAULT_NETWORK].chainId;
  let reportVersion: number | null = null;
  try {
    reportVersion = Number(decodeFunctionResult({ abi: vaultAbi, functionName: 'reportVersion', data: bytesToHex(call(vaultSelector, vaultAddress, encodeFunctionData({ abi: vaultAbi, functionName: 'reportVersion' })).data) }));
  } catch {
    reportVersion = null;
  }
  if (reportVersion !== REPORT_VERSION)
    throw new Error(`Vault ${vaultAddress} accepts report ${reportVersion ? `v${reportVersion}` : 'v1'}, not v${REPORT_VERSION}; redeploy with scripts/deploy-sepolia.ts. Nothing was submitted.`);
  const paused = decodeFunctionResult({ abi: vaultAbi, functionName: 'paused', data: bytesToHex(call(vaultSelector, vaultAddress, encodeFunctionData({ abi: vaultAbi, functionName: 'paused' })).data) });
  const balance = clientFor(vaultSelector).balanceAt(runtime, { account: vaultAddress, blockNumber: LATEST_BLOCK_NUMBER }).result();

  const fetchedAt = runtime.now().toISOString();
  const observations: Observation[] = [];
  for (const source of collectSources(graph)) {
    const identity = sourceIdentity(source);
    runtime.log(`ORIGINS_SOURCE Reading ${describeSource(source)}${identity.address ? ` at ${identity.address}` : ''}`);
    if (source.type === 'exchange-trade') {
      const trade = new HTTPClient().sendRequest(runtime, (sender) => fetchPrice(sender,priceUrl(source.pair)), ConsensusAggregationByFields<{ usd: number; observedAt: number }>({ usd: median<number>, observedAt: median<number> }))().result();
      observations.push({ ...identity, usd: trade.usd, raw: String(trade.usd), observedAt: new Date(trade.observedAt).toISOString(), fetchedAt });
    } else {
      const round = decodeFunctionResult({ abi: feedAbi, functionName: 'latestRoundData', data: bytesToHex(call(NETWORKS[source.network].chainSelector, identity.address!, encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' })).data) });
      const [roundId, answer, , updatedAt] = round;
      if (answer <= 0n) throw new Error(`${describeSource(source)} returned a non-positive answer`);
      if (updatedAt === 0n) throw new Error(`${describeSource(source)} has no completed round`);
      observations.push({ ...identity, usd: Number(answer) / 10 ** FEED_DECIMALS, raw: answer.toString(), roundId: roundId.toString(), observedAt: new Date(Number(updatedAt) * 1000).toISOString(), fetchedAt });
    }
  }
  const readings: Record<string, PriceReading> = Object.fromEntries(observations.map((o) => [o.key, { usd: o.usd, observedAt: o.observedAt }]));
  const nowMs = runtime.now().getTime();
  const result = evaluateGraph(graph, { readings, vaultPaused: paused, exchangeMaxAgeSeconds: spec.maxAgeSeconds }, nowMs);
  const evidence: any = {
    runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash, mode: 'cre-local-simulation', observations,
    vault: { address: vaultAddress, chainId: vaultChainId, paused, balanceWei: (balance.balance ? protoBigIntToBigint(balance.balance) : 0n).toString(), reportVersion },
    conditions: result.conditions, root: result.root, decision: result.decision, action: graph.action.type, decidedAt: new Date(nowMs).toISOString(), logs: [],
  };
  if (result.decision === 'noop') evidence.noopReason = explainNoop(result);
  if (result.decision === 'act' && spec.broadcast === false) evidence.dryRun = true;
  if (result.decision === 'act' && spec.broadcast !== false) {
    const encoded = encodePauseReport({ target: vaultAddress, chainId: vaultChainId, runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash as Hex, decidedAt: Math.floor(nowMs / 1000) });
    const report = runtime.report({ encodedPayload: hexToBase64(encoded), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();
    const tx = clientFor(vaultSelector).writeReport(runtime, { receiver: vaultAddress, report, gasConfig: { gasLimit: runtime.config.gasLimit } }).result();
    if(tx.txHash) runtime.log("ORIGINS_SUBMITTED "+JSON.stringify({hash:bytesToHex(tx.txHash),runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash}));
    const receiverConfirmed = tx.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.SUCCESS;
    evidence.transaction = { hash: tx.txHash ? bytesToHex(tx.txHash) : null, status: tx.txStatus === TxStatus.SUCCESS ? 'success' : 'failed', receiverConfirmed };
    if (tx.txStatus !== TxStatus.SUCCESS || !receiverConfirmed) throw new Error(`Report did not execute successfully: ${tx.errorMessage || tx.receiverContractExecutionStatus}`);
  }
  const json = JSON.stringify(evidence);
  for (const chunk of evidenceChunks(json)) runtime.log(chunk);
  return json;
}
