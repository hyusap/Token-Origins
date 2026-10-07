import { z } from 'zod';
import type { ConditionEvidence } from './spec';

/**
 * Bounded policy graph. Composition stays an allowlisted node vocabulary: the
 * agent assembles nodes and edges, never code and never a free-form URL, so a
 * composed graph can be evaluated identically by the local runner and inside
 * the CRE workflow.
 */

// Addresses live in server/chainlink.ts. Only the names are shared here so the
// WASM bundle never pulls an RPC client in; a test pins the two lists together.
export const FEED_SYMBOLS = ['ETH','BTC','LINK','SOL','BNB','AVAX','MATIC','AAVE','UNI','COMP','MKR','SNX','CRV','USDC','USDT','DAI'] as const;
export type FeedSymbol = (typeof FEED_SYMBOLS)[number];

export const priceSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exchange-trade'), pair: z.literal('ETH-USD') }).strict(),
  z.object({ type: z.literal('chainlink-feed'), symbol: z.enum(FEED_SYMBOLS) }).strict(),
]);
export type PriceSource = z.infer<typeof priceSourceSchema>;
export const sourceKey = (source: PriceSource): string =>
  source.type === 'chainlink-feed' ? `chainlink-feed:${source.symbol}` : `exchange-trade:${source.pair}`;
export const describeSource = (source: PriceSource): string =>
  source.type === 'chainlink-feed' ? `Chainlink ${source.symbol}/USD` : `Coinbase ${source.pair} trade`;

const id = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
export const COMPARATORS = ['<', '<=', '>', '>='] as const;

export const graphNodeSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('price'), source: priceSourceSchema }).strict(),
  z.object({ id, kind: z.literal('compare'), input: id, op: z.enum(COMPARATORS), value: z.number().positive().max(1e7) }).strict(),
  z.object({ id, kind: z.literal('freshness'), input: id, maxAgeSeconds: z.number().int().min(1).max(86400) }).strict(),
  z.object({ id, kind: z.literal('vault-paused'), equals: z.boolean() }).strict(),
  z.object({ id, kind: z.literal('and'), inputs: z.array(id).min(2).max(8) }).strict(),
  z.object({ id, kind: z.literal('or'), inputs: z.array(id).min(2).max(8) }).strict(),
  z.object({ id, kind: z.literal('not'), input: id }).strict(),
]);
export type GraphNode = z.infer<typeof graphNodeSchema>;

/**
 * Terminal actions. pause-vault is the real one: it delivers a signed report to
 * GrantVault. sell is a MOCK venue order — no contract, no asset movement, no
 * counterparty. It exists so a composed policy can end in something other than
 * a pause, and it records what it would have submitted. Any surface showing a
 * sell result has to say simulated.
 */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause-vault') }).strict(),
  z.object({
    type: z.literal('sell'),
    symbol: z.enum(FEED_SYMBOLS),
    amount: z.number().positive().max(1e9),
    venue: z.literal('mock-venue').default('mock-venue'),
  }).strict(),
]);
export type PolicyAction = z.infer<typeof actionSchema>;

export const policyGraphSchema = z.object({
  nodes: z.array(graphNodeSchema).min(1).max(40),
  root: id,
  action: actionSchema,
}).strict();
export type PolicyGraph = z.infer<typeof policyGraphSchema>;

type ValueType = 'price' | 'bool';
const inputsOf = (node: GraphNode): string[] =>
  node.kind === 'and' || node.kind === 'or' ? node.inputs
    : node.kind === 'compare' || node.kind === 'freshness' || node.kind === 'not' ? [node.input]
    : [];

/**
 * Static check: unique ids, resolvable edges, no cycles, well-typed operands,
 * and a boolean root. Evaluation assumes a graph that has passed this.
 */
export function validateGraph(input: unknown): { graph: PolicyGraph; types: Map<string, ValueType> } {
  const graph = policyGraphSchema.parse(input);
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
    byId.set(node.id, node);
  }
  for (const node of graph.nodes)
    for (const ref of inputsOf(node))
      if (!byId.has(ref)) throw new Error(`Node "${node.id}" references unknown node "${ref}"`);
  if (!byId.has(graph.root)) throw new Error(`Root "${graph.root}" is not a node in the graph`);

  const types = new Map<string, ValueType>();
  const state = new Map<string, 'visiting' | 'done'>();
  const typeOf = (nodeId: string): ValueType => {
    const seen = state.get(nodeId);
    if (seen === 'done') return types.get(nodeId)!;
    if (seen === 'visiting') throw new Error(`Graph contains a cycle through "${nodeId}"`);
    state.set(nodeId, 'visiting');
    const node = byId.get(nodeId)!;
    let type: ValueType;
    if (node.kind === 'price') type = 'price';
    else if (node.kind === 'vault-paused') type = 'bool';
    else if (node.kind === 'compare' || node.kind === 'freshness') {
      if (typeOf(node.input) !== 'price')
        throw new Error(`"${node.id}" (${node.kind}) needs a price node, but "${node.input}" is a condition`);
      type = 'bool';
    } else {
      for (const ref of inputsOf(node))
        if (typeOf(ref) !== 'bool')
          throw new Error(`"${node.id}" (${node.kind}) needs conditions, but "${ref}" is a price`);
      type = 'bool';
    }
    state.set(nodeId, 'done');
    types.set(nodeId, type);
    return type;
  };
  for (const node of graph.nodes) typeOf(node.id);
  if (types.get(graph.root) !== 'bool')
    throw new Error(`Root "${graph.root}" must be a condition, not a price reading`);
  return { graph, types };
}

/** Every distinct source a graph needs fetched, deduplicated. */
export function collectSources(graph: PolicyGraph): PriceSource[] {
  const seen = new Map<string, PriceSource>();
  for (const node of graph.nodes)
    if (node.kind === 'price') seen.set(sourceKey(node.source), node.source);
  return [...seen.values()];
}

export interface PriceReading { usd: number; observedAt: string }
export interface GraphInputs {
  /** Keyed by sourceKey(). Must cover every source collectSources() reports. */
  prices: Record<string, PriceReading>;
  vaultPaused: boolean;
  /** The observation the on-chain report will carry; always the exchange trade. */
  executionPrice: PriceReading;
  /** The receiver's own staleness cap, which no composed graph may widen. */
  executionMaxAgeSeconds: number;
  /** Threshold the report will carry. GrantVault reverts unless price < threshold. */
  reportedThresholdUsd: number;
}
export interface GraphEvidence extends ConditionEvidence { nodeId: string }
export interface GraphResult { evidence: GraphEvidence[]; decision: 'pause' | 'noop' }

const ageSeconds = (observedAt: string, nowMs: number) => (nowMs - Date.parse(observedAt)) / 1000;
const fresh = (age: number, limit: number) => Number.isFinite(age) && age >= 0 && age <= limit;
const compare = (left: number, op: (typeof COMPARATORS)[number], right: number): boolean => {
  // Cents, so a composed threshold compares the way it was spoken.
  const a = Math.round(left * 100), b = Math.round(right * 100);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
};

/**
 * Pure evaluation. Sources are resolved by the caller, because the local runner
 * fetches directly while the CRE handler resolves through DON consensus.
 *
 * The receiver's freshness cap and the already-paused no-op are appended for
 * every run whether or not the composed graph expresses them, so removing those
 * nodes relaxes the narrative and never the actual guard.
 */
export function evaluateGraph(graph: PolicyGraph, inputs: GraphInputs, nowMs: number): GraphResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const evidence: GraphEvidence[] = [];
  const memo = new Map<string, boolean | PriceReading>();

  const value = (nodeId: string): boolean | PriceReading => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    const node = byId.get(nodeId)!;
    let result: boolean | PriceReading;
    if (node.kind === 'price') {
      const reading = inputs.prices[sourceKey(node.source)];
      if (!reading) throw new Error(`Missing resolved reading for ${describeSource(node.source)}`);
      result = reading;
    } else if (node.kind === 'compare') {
      const reading = value(node.input) as PriceReading;
      const source = byId.get(node.input) as Extract<GraphNode, { kind: 'price' }>;
      result = compare(reading.usd, node.op, node.value);
      evidence.push({
        nodeId: node.id, kind: 'threshold', passed: result,
        detail: `${describeSource(source.source)} $${reading.usd.toFixed(2)} ${node.op} $${node.value.toFixed(2)}`,
      });
    } else if (node.kind === 'freshness') {
      const reading = value(node.input) as PriceReading;
      const source = byId.get(node.input) as Extract<GraphNode, { kind: 'price' }>;
      const age = ageSeconds(reading.observedAt, nowMs);
      result = fresh(age, node.maxAgeSeconds);
      evidence.push({
        nodeId: node.id, kind: 'freshness', passed: result,
        detail: `${describeSource(source.source)} observed ${age.toFixed(1)}s ago; maximum ${node.maxAgeSeconds}s`,
      });
    } else if (node.kind === 'vault-paused') {
      result = inputs.vaultPaused === node.equals;
      evidence.push({
        nodeId: node.id, kind: 'vault-state', passed: result,
        detail: `Vault is ${inputs.vaultPaused ? 'paused' : 'active'}; condition wants ${node.equals ? 'paused' : 'active'}`,
      });
    } else if (node.kind === 'not') {
      result = !(value(node.input) as boolean);
      evidence.push({ nodeId: node.id, kind: 'not', passed: result, detail: `NOT ${node.input}` });
    } else {
      const parts = node.inputs.map((ref) => value(ref) as boolean);
      result = node.kind === 'and' ? parts.every(Boolean) : parts.some(Boolean);
      evidence.push({
        nodeId: node.id, kind: node.kind, passed: result,
        detail: `${node.inputs.join(` ${node.kind.toUpperCase()} `)} → ${result ? 'true' : 'false'}`,
      });
    }
    memo.set(nodeId, result);
    return result;
  };

  const composed = value(graph.root) as boolean;
  const executionAge = ageSeconds(inputs.executionPrice.observedAt, nowMs);
  const guards: GraphEvidence[] = [
    {
      nodeId: 'guard:composed', kind: 'composed-policy', passed: composed,
      detail: `Composed policy root "${graph.root}" evaluated ${composed ? 'true' : 'false'}`,
    },
    {
      nodeId: 'guard:freshness', kind: 'freshness', passed: fresh(executionAge, inputs.executionMaxAgeSeconds),
      detail: `Reported observation age ${executionAge.toFixed(1)}s; receiver maximum ${inputs.executionMaxAgeSeconds}s`,
    },
    {
      nodeId: 'guard:vault-state', kind: 'vault-state', passed: !inputs.vaultPaused,
      detail: inputs.vaultPaused ? 'Vault already paused; no action needed' : 'Vault spending active',
    },
  ];
  // GrantVault.onReport reverts InvalidReport unless the reported price is below
  // the reported threshold. A graph that pauses on a rising price would satisfy
  // its own logic and still be rejected on delivery, so surface that as evidence
  // rather than as an opaque revert. A simulated sell delivers no report, so the
  // receiver's rule does not apply to it.
  if (graph.action.type === 'pause-vault')
    guards.push({
      nodeId: 'guard:receiver-threshold', kind: 'receiver-compatibility',
      passed: Math.round(inputs.executionPrice.usd * 100) < Math.round(inputs.reportedThresholdUsd * 100),
      detail: `Receiver accepts a report only below its threshold: $${inputs.executionPrice.usd.toFixed(2)} vs $${inputs.reportedThresholdUsd.toFixed(2)}`,
    });
  // Only the root verdict and the mandatory guards gate the action. An OR with
  // one false branch, or a NOT over a true one, is a passing policy whose trace
  // legitimately contains failed intermediate nodes.
  return {
    evidence: [...evidence, ...guards],
    decision: guards.every((guard) => guard.passed) ? 'pause' : 'noop',
  };
}

/**
 * The three-scalar policy expressed as a graph. The freshness cap and the
 * already-paused guard are not emitted as nodes because evaluateGraph appends
 * both unconditionally; spelling them out again would double the evidence.
 */
export function legacyGraph(thresholdUsd: number): PolicyGraph {
  return {
    nodes: [
      { id: 'eth', kind: 'price', source: { type: 'exchange-trade', pair: 'ETH-USD' } },
      { id: 'under-threshold', kind: 'compare', input: 'eth', op: '<', value: thresholdUsd },
    ],
    root: 'under-threshold',
    action: { type: 'pause-vault' },
  };
}

/** One readable sentence per graph, for the agent's narration and the canvas. */
export function describeGraph(graph: PolicyGraph): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  const phrase = (nodeId: string): string => {
    if (seen.has(nodeId)) return nodeId;
    seen.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return nodeId;
    switch (node.kind) {
      case 'price':
        return describeSource(node.source);
      case 'compare':
        return `${phrase(node.input)} ${node.op} $${node.value.toLocaleString('en-US')}`;
      case 'freshness':
        return `${phrase(node.input)} observed within ${node.maxAgeSeconds}s`;
      case 'vault-paused':
        return `vault is ${node.equals ? 'paused' : 'active'}`;
      case 'not':
        return `not (${phrase(node.input)})`;
      default:
        return `(${node.inputs.map(phrase).join(node.kind === 'and' ? ' and ' : ' or ')})`;
    }
  };
  const action =
    graph.action.type === 'sell'
      ? `Submit a simulated sell of ${graph.action.amount} ${graph.action.symbol}`
      : 'Pause spending';
  return `${action} when ${phrase(graph.root)}.`;
}

/**
 * True when a graph is still the shape a scalar threshold edit can express.
 * Scalar edits regenerate such a graph; against a composed one they refuse,
 * rather than silently discarding branches the speaker added.
 */
export function isLegacyShape(graph: PolicyGraph): boolean {
  if (graph.nodes.length !== 2) return false;
  const compare = graph.nodes.find((node) => node.kind === 'compare');
  const price = graph.nodes.find((node) => node.kind === 'price');
  return Boolean(
    compare && price && compare.kind === 'compare' && price.kind === 'price' &&
    compare.input === price.id && compare.op === '<' && graph.root === compare.id &&
    price.source.type === 'exchange-trade',
  );
}

/**
 * Sepolia aggregators, used by the CRE path so the vault and every feed it reads
 * sit on one chain and one chainSelector. Each verified on-chain by description()
 * before inclusion; symbols absent here have no Sepolia feed and must fail loudly
 * rather than silently resolve to a mainnet address the DON cannot reach.
 */
export const SEPOLIA_FEEDS: Partial<Record<FeedSymbol, `0x${string}`>> = {
  ETH: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
  BTC: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
  LINK: '0xc59E3633BAAC79493d908e63626716e204A45EdF',
  USDC: '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
  DAI: '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19',
  SNX: '0xc0F82A46033b8BdBA4Bb0B0e28Bc2006F64355bC',
};
