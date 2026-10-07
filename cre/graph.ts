import { z } from 'zod';
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';

/**
 * Bounded policy graph. Composition stays an allowlisted node vocabulary: the
 * agent assembles nodes and edges, never code and never a free-form URL, so a
 * composed graph is evaluated identically by the fixture rehearsal, the local
 * EVM runner and the CRE workflow. See docs/execution-contract.md.
 */

/** Bump when the meaning of a graph, its hash, or its evidence changes. */
export const GRAPH_VERSION = 2;
/** GrantVault report layout this code produces. Older receivers are refused before submission. */
export const REPORT_VERSION = 2;
export const ACTION_PAUSE = 1;

// ---------------------------------------------------------------------------
// Source identity. A feed is (network, symbol) and resolves to exactly one
// aggregator address from this registry. A mainnet feed and a Sepolia feed are
// different inputs; nothing substitutes one for the other.
// ---------------------------------------------------------------------------

export const NETWORKS = {
  'ethereum-mainnet': { chainId: 1, chainSelector: '5009297550715157269', creChainName: 'ethereum-mainnet', label: 'Ethereum mainnet', explorer: 'https://etherscan.io' },
  'ethereum-sepolia': { chainId: 11155111, chainSelector: '16015286601757825753', creChainName: 'ethereum-testnet-sepolia', label: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
} as const;
export type Network = keyof typeof NETWORKS;
export const NETWORK_IDS = Object.keys(NETWORKS) as [Network, ...Network[]];
export const DEFAULT_FEED_NETWORK: Network = 'ethereum-mainnet';

export const FEED_SYMBOLS = ['ETH','BTC','LINK','SOL','BNB','AVAX','MATIC','AAVE','UNI','COMP','MKR','SNX','CRV','USDC','USDT','DAI'] as const;
export type FeedSymbol = (typeof FEED_SYMBOLS)[number];
/** Every USD Data Feed in this registry reports 8 decimals; the backend re-checks decimals() on each read. */
export const FEED_DECIMALS = 8;

/**
 * Aggregator proxies, each verified on-chain by description() before inclusion.
 * Symbols absent from a network have no feed there and fail validation.
 */
export const FEED_REGISTRY: Record<Network, Partial<Record<FeedSymbol, `0x${string}`>>> = {
  'ethereum-mainnet': {
    ETH: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    BTC: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    LINK: '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    SOL: '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
    BNB: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A',
    AVAX: '0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7',
    MATIC: '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676',
    AAVE: '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    UNI: '0x553303d460EE0afB37EdFf9bE42922D8FF63220e',
    COMP: '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
    MKR: '0xec1D1B3b0443256cc3860e24a46F108e699484Aa',
    SNX: '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699',
    CRV: '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f',
    USDC: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    USDT: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    DAI: '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
  },
  'ethereum-sepolia': {
    ETH: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
    BTC: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
    LINK: '0xc59E3633BAAC79493d908e63626716e204A45EdF',
    USDC: '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
    DAI: '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19',
    SNX: '0xc0F82A46033b8BdBA4Bb0B0e28Bc2006F64355bC',
  },
};
export const feedAddress = (network: Network, symbol: FeedSymbol): `0x${string}` | undefined => FEED_REGISTRY[network][symbol];

export const priceSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exchange-trade'), pair: z.literal('ETH-USD') }).strict(),
  z.object({
    type: z.literal('chainlink-feed'),
    symbol: z.enum(FEED_SYMBOLS),
    network: z.enum(NETWORK_IDS).default(DEFAULT_FEED_NETWORK),
  }).strict(),
]);
export type PriceSource = z.infer<typeof priceSourceSchema>;
export type FeedSource = Extract<PriceSource, { type: 'chainlink-feed' }>;
export const sourceKey = (source: PriceSource): string =>
  source.type === 'chainlink-feed' ? `chainlink-feed:${source.network}:${source.symbol}` : `exchange-trade:${source.pair}`;
export const describeSource = (source: PriceSource): string =>
  source.type === 'chainlink-feed'
    ? `Chainlink ${source.symbol}/USD (${source.network === 'ethereum-mainnet' ? 'mainnet' : 'Sepolia'})`
    : `Coinbase ${source.pair} trade`;

/** Where a reading must come from. Part of the policy hash and of every observation. */
export interface SourceIdentity {
  key: string;
  provider: 'coinbase' | 'chainlink';
  label: string;
  network?: Network;
  chainId?: number;
  address?: `0x${string}`;
  decimals?: number;
  url?: string;
}
export const EXCHANGE_TRADE_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/ticker';
export function sourceIdentity(source: PriceSource): SourceIdentity {
  if (source.type === 'exchange-trade')
    return { key: sourceKey(source), provider: 'coinbase', label: describeSource(source), url: EXCHANGE_TRADE_URL };
  const address = feedAddress(source.network, source.symbol);
  if (!address) throw new Error(`No Chainlink ${source.symbol}/USD feed is configured on ${NETWORKS[source.network].label}`);
  return {
    key: sourceKey(source), provider: 'chainlink', label: describeSource(source), network: source.network,
    chainId: NETWORKS[source.network].chainId, address, decimals: FEED_DECIMALS,
  };
}

// ---------------------------------------------------------------------------
// Graph shape
// ---------------------------------------------------------------------------

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
 * counterparty, local rehearsal only. Any surface showing a sell result has to
 * say simulated.
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
/** Accepts graphs written before feed sources carried a network. */
export type PolicyGraphInput = z.input<typeof policyGraphSchema>;

/**
 * CRE allows 10 EVM reads and 5 HTTP calls per execution. A run reads the
 * vault three times and each source once, so five distinct sources keeps every
 * graph inside the quota with room to spare.
 */
export const MAX_SOURCES = 5;

type ValueType = 'price' | 'bool';
const inputsOf = (node: GraphNode): string[] =>
  node.kind === 'and' || node.kind === 'or' ? node.inputs
    : node.kind === 'compare' || node.kind === 'freshness' || node.kind === 'not' ? [node.input]
    : [];

/**
 * Static check: unique ids, resolvable edges, no cycles, well-typed operands,
 * a boolean root, every node connected to that root, every feed present on
 * its network, and a bounded fetch plan. Every execution boundary calls this;
 * evaluation assumes a graph that has passed it.
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

  // A node the root never reaches would be displayed and fetched without
  // deciding anything. Refuse it so the canvas and the evaluator agree.
  const reached = new Set<string>();
  const walk = (nodeId: string) => {
    if (reached.has(nodeId)) return;
    reached.add(nodeId);
    for (const ref of inputsOf(byId.get(nodeId)!)) walk(ref);
  };
  walk(graph.root);
  const orphans = graph.nodes.filter((node) => !reached.has(node.id)).map((node) => node.id);
  if (orphans.length)
    throw new Error(`Node${orphans.length > 1 ? 's' : ''} ${orphans.map((x) => `"${x}"`).join(', ')} not connected to root "${graph.root}"; remove or connect ${orphans.length > 1 ? 'them' : 'it'}`);

  const sources = collectSources(graph);
  for (const source of sources) sourceIdentity(source);
  if (sources.length > MAX_SOURCES)
    throw new Error(`A policy may read at most ${MAX_SOURCES} distinct sources; this one reads ${sources.length}`);
  return { graph, types };
}

/** Every distinct source a graph needs fetched, deduplicated, in first-use order. */
export function collectSources(graph: PolicyGraph): PriceSource[] {
  const seen = new Map<string, PriceSource>();
  for (const node of graph.nodes)
    if (node.kind === 'price') seen.set(sourceKey(node.source), node.source);
  return [...seen.values()];
}

/** True when execution must read the vault: it is the action's target or a condition reads it. */
export const readsVault = (graph: PolicyGraph): boolean =>
  graph.action.type === 'pause-vault' || graph.nodes.some((node) => node.kind === 'vault-paused');

// ---------------------------------------------------------------------------
// Policy identity. The hash is structural: node ids and declaration order do
// not change it, AND/OR operands are order-free, and every feed is bound to its
// network and aggregator address. The report and the receiver event carry it.
// ---------------------------------------------------------------------------

/** USD amounts compare as integers at 1e-8, the precision of Chainlink USD feeds. */
export const USD_SCALE = 100_000_000;
export const toUsdUnits = (usd: number): number => Math.round(usd * USD_SCALE);

export function policyHash(input: PolicyGraphInput | PolicyGraph): Hex {
  const graph = policyGraphSchema.parse(input);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const memo = new Map<string, string>();
  const digest = (text: string) => keccak256(toBytes(text));
  const hashOf = (nodeId: string): string => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const node = byId.get(nodeId);
    if (!node) throw new Error(`Cannot hash unknown node "${nodeId}"`);
    let text: string;
    switch (node.kind) {
      case 'price': {
        const identity = sourceIdentity(node.source);
        text = `price(${identity.key}${identity.address ? `@${identity.address.toLowerCase()}` : ''})`;
        break;
      }
      case 'compare': text = `compare(${node.op},${toUsdUnits(node.value)},${hashOf(node.input)})`; break;
      case 'freshness': text = `freshness(${node.maxAgeSeconds},${hashOf(node.input)})`; break;
      case 'vault-paused': text = `vault-paused(${node.equals})`; break;
      case 'not': text = `not(${hashOf(node.input)})`; break;
      default: text = `${node.kind}(${[...new Set(node.inputs.map(hashOf))].sort().join(',')})`;
    }
    const value = digest(text);
    memo.set(nodeId, value);
    return value;
  };
  const action = graph.action.type === 'sell'
    ? `sell(${graph.action.symbol},${graph.action.amount},${graph.action.venue})`
    : 'pause-vault';
  return digest(`sotto-policy/v${GRAPH_VERSION}|${hashOf(graph.root)}|${action}`);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PriceReading { usd: number; observedAt: string }
/** One archived input. Everything needed to re-check the decision later. */
export interface Observation extends SourceIdentity {
  usd: number;
  /** Raw integer answer for oracle reads; exact string for exchange trades. */
  raw: string;
  observedAt: string;
  fetchedAt: string;
  roundId?: string;
}
/** Exchange trades must be this fresh at most; a run can tighten it but never relax it. */
export const MAX_EXCHANGE_AGE_SECONDS = 120;
/**
 * Data Feeds update on deviation or a heartbeat of up to 24 hours. A reading
 * older than one missed heartbeat plus margin means the feed is not updating.
 */
export const MAX_FEED_AGE_SECONDS = 26 * 3600;
/** Tolerated clock disagreement before a timestamp counts as "from the future". */
export const MAX_FUTURE_SKEW_SECONDS = 30;

export interface GraphInputs {
  /** Keyed by sourceKey(). Must cover every source collectSources() reports. */
  readings: Record<string, PriceReading>;
  /** Fresh vault read; null when the graph neither targets nor reads the vault. */
  vaultPaused: boolean | null;
  /** Exchange trade age cap for this run, 1–120 seconds. */
  exchangeMaxAgeSeconds: number;
}
export type ResultRole = 'node' | 'root' | 'guard';
export interface ConditionEvidence { nodeId: string; kind: string; role: ResultRole; passed: boolean; detail: string }
export interface GraphResult {
  conditions: ConditionEvidence[];
  /** The composed policy's own verdict. */
  root: boolean;
  /** 'act' only when the root holds and every mandatory guard passes. */
  decision: 'act' | 'noop';
  /** First failing gate when the decision is noop: the root or a named guard. */
  blockedBy?: ConditionEvidence;
}

const ageSeconds = (observedAt: string, nowMs: number) => (nowMs - Date.parse(observedAt)) / 1000;
const withinAge = (age: number, limit: number) => Number.isFinite(age) && age >= -MAX_FUTURE_SKEW_SECONDS && age <= limit;
const compareUsd = (left: number, op: (typeof COMPARATORS)[number], right: number): boolean => {
  const a = toUsdUnits(left), b = toUsdUnits(right);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
};
/** Shows enough decimals for stablecoin thresholds without padding large prices. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const digits = Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : 8;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })}`;
}

/**
 * Pure evaluation shared by every execution path. Sources are resolved by the
 * caller; a missing reading throws rather than counting as false (which a NOT
 * would turn into true).
 *
 * Mandatory guards are appended whether or not the graph expresses them:
 * every source within its freshness limit and, for a vault pause, a vault that
 * is not already paused. Only the root and these guards gate the action, so a
 * false branch inside a passing OR is not a failure.
 */
export function evaluateGraph(graph: PolicyGraph, inputs: GraphInputs, nowMs: number): GraphResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const conditions: ConditionEvidence[] = [];
  const memo = new Map<string, boolean | PriceReading>();
  const reading = (source: PriceSource): PriceReading => {
    const value = inputs.readings[sourceKey(source)];
    if (!value || !Number.isFinite(value.usd) || value.usd <= 0 || !Number.isFinite(Date.parse(value.observedAt)))
      throw new Error(`Missing resolved reading for ${describeSource(source)}`);
    return value;
  };

  const value = (nodeId: string): boolean | PriceReading => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    const node = byId.get(nodeId);
    if (!node) throw new Error(`Unknown node "${nodeId}"`);
    let result: boolean | PriceReading;
    if (node.kind === 'price') result = reading(node.source);
    else if (node.kind === 'compare') {
      const price = value(node.input) as PriceReading;
      const source = (byId.get(node.input) as Extract<GraphNode, { kind: 'price' }>).source;
      result = compareUsd(price.usd, node.op, node.value);
      conditions.push({ nodeId: node.id, kind: 'threshold', role: 'node', passed: result, detail: `${describeSource(source)} ${formatUsd(price.usd)} ${node.op} ${formatUsd(node.value)}` });
    } else if (node.kind === 'freshness') {
      const price = value(node.input) as PriceReading;
      const source = (byId.get(node.input) as Extract<GraphNode, { kind: 'price' }>).source;
      const age = ageSeconds(price.observedAt, nowMs);
      result = withinAge(age, node.maxAgeSeconds);
      conditions.push({ nodeId: node.id, kind: 'freshness', role: 'node', passed: result, detail: `${describeSource(source)} observed ${age.toFixed(1)}s ago; maximum ${node.maxAgeSeconds}s` });
    } else if (node.kind === 'vault-paused') {
      if (inputs.vaultPaused === null) throw new Error('Policy reads vault state but no vault read was supplied');
      result = inputs.vaultPaused === node.equals;
      conditions.push({ nodeId: node.id, kind: 'vault-state', role: 'node', passed: result, detail: `Vault is ${inputs.vaultPaused ? 'paused' : 'active'}; condition wants ${node.equals ? 'paused' : 'active'}` });
    } else if (node.kind === 'not') {
      result = !(value(node.input) as boolean);
      conditions.push({ nodeId: node.id, kind: 'not', role: 'node', passed: result, detail: `NOT ${node.input} → ${result}` });
    } else {
      const parts = node.inputs.map((ref) => value(ref) as boolean);
      result = node.kind === 'and' ? parts.every(Boolean) : parts.some(Boolean);
      conditions.push({ nodeId: node.id, kind: node.kind, role: 'node', passed: result, detail: `${node.inputs.join(` ${node.kind.toUpperCase()} `)} → ${result}` });
    }
    memo.set(nodeId, result);
    return result;
  };

  const root = value(graph.root) as boolean;
  const gates: ConditionEvidence[] = [
    { nodeId: 'guard:root', kind: 'composed-policy', role: 'root', passed: root, detail: `Policy root "${graph.root}" evaluated ${root}` },
  ];
  const exchangeLimit = Math.min(Math.max(1, Math.floor(inputs.exchangeMaxAgeSeconds)), MAX_EXCHANGE_AGE_SECONDS);
  for (const source of collectSources(graph)) {
    const limit = source.type === 'exchange-trade' ? exchangeLimit : MAX_FEED_AGE_SECONDS;
    const age = ageSeconds(reading(source).observedAt, nowMs);
    gates.push({
      nodeId: `guard:source:${sourceKey(source)}`, kind: 'source-freshness', role: 'guard', passed: withinAge(age, limit),
      detail: age < -MAX_FUTURE_SKEW_SECONDS
        ? `${describeSource(source)} timestamp is ${(-age).toFixed(0)}s in the future`
        : `${describeSource(source)} observed ${age.toFixed(1)}s ago; limit ${limit}s`,
    });
  }
  if (graph.action.type === 'pause-vault') {
    if (inputs.vaultPaused === null) throw new Error('A vault pause needs a fresh vault read');
    gates.push({
      nodeId: 'guard:vault-active', kind: 'vault-state', role: 'guard', passed: !inputs.vaultPaused,
      detail: inputs.vaultPaused ? 'Vault already paused; no second pause needed' : 'Vault spending active',
    });
  }
  const blockedBy = gates.find((gate) => !gate.passed);
  return { conditions: [...conditions, ...gates], root, decision: blockedBy ? 'noop' : 'act', ...(blockedBy ? { blockedBy } : {}) };
}

/** Plain-language reason for a noop, from the gate that actually stopped it. */
export function explainNoop(result: GraphResult): string {
  const gate = result.blockedBy;
  if (!gate) return 'No action was needed.';
  if (gate.role === 'root') return 'The policy condition was not met.';
  if (gate.kind === 'vault-state') return 'The vault was already paused, so no second pause was sent.';
  if (gate.kind === 'source-freshness') return `An input was too old or future-dated: ${gate.detail}.`;
  return gate.detail;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const runIdHash = (runId: string): Hex => keccak256(toBytes(runId));
export interface PauseReport { target: `0x${string}`; chainId: number; runId: string; revision: number; policyHash: Hex; decidedAt: number }
/**
 * Report v2: (version, target, chainId, runIdHash, revision, policyHash, action, decidedAt).
 * The receiver checks forwarder, version, target, chain, action, replay and age;
 * the decision itself was made by the workflow that the forwarder authenticates.
 */
export function encodePauseReport(report: PauseReport): Hex {
  return encodeAbiParameters(
    parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256'),
    [BigInt(REPORT_VERSION), report.target, BigInt(report.chainId), runIdHash(report.runId), BigInt(report.revision), report.policyHash, BigInt(ACTION_PAUSE), BigInt(report.decidedAt)],
  );
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

/**
 * The single-compare shape a scalar threshold edit can express. Scalar edits
 * regenerate such a graph; against a composed one they refuse, rather than
 * silently discarding branches the speaker added.
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

export function isLegacyShape(graph: PolicyGraph | undefined | null): boolean {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length !== 2 || graph.action?.type !== 'pause-vault') return false;
  const compare = graph.nodes.find((node) => node.kind === 'compare');
  const price = graph.nodes.find((node) => node.kind === 'price');
  return Boolean(
    compare && price && compare.kind === 'compare' && price.kind === 'price' &&
    compare.input === price.id && compare.op === '<' && graph.root === compare.id &&
    price.source.type === 'exchange-trade',
  );
}

export function describeAction(action: PolicyAction): string {
  return action.type === 'sell' ? `Simulated sell of ${action.amount} ${action.symbol}` : 'Pause grant vault spending';
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
        return `${phrase(node.input)} ${node.op} $${node.value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
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
