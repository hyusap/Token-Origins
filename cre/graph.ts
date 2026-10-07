import { z } from 'zod';
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';

/**
 * Bounded policy graph. Composition stays an allowlisted node vocabulary: the
 * agent assembles nodes and edges, never code and never a free-form URL, so a
 * composed graph is evaluated identically by the fixture rehearsal, the local
 * EVM runner and the CRE workflow. See docs/execution-contract.md.
 */

/**
 * Hash domain of the policy graph. New node kinds, sources and actions are
 * additive: every graph that was valid before hashes exactly as it did, so
 * recorded on-chain evidence keeps verifying. Bump only when the meaning of an
 * existing graph changes.
 */
export const GRAPH_VERSION = 2;
/** Report layout of the current GrantVault: every real action (pause, sweep, pay, evacuate). */
export const REPORT_VERSION = 3;
/** Pause-only layout that vaults deployed before treasury actions accept. Still produced for them. */
export const PAUSE_REPORT_VERSION = 2;
export const ACTION_PAUSE = 1;
export const ACTION_SWEEP = 2;
export const ACTION_PAY = 3;
export const ACTION_EVACUATE = 4;
/** Report flag: also pause spending in the same delivery. */
export const FLAG_PAUSE = 1;

// ---------------------------------------------------------------------------
// Source identity. Every reading resolves to exactly one registry entry: a
// network and a contract address (or the one exchange endpoint). A mainnet
// feed and a Sepolia feed are different inputs; nothing substitutes one for
// the other.
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

/**
 * Chainlink Proof of Reserve feeds: the same AggregatorV3 interface as price
 * feeds, answering the custodied reserve in units of the backed asset.
 * `bun run verify:registry` re-checks every address here against the chain.
 */
export const POR_REGISTRY = {
  WBTC: { network: 'ethereum-mainnet', address: '0xa81FE04086865e63E12dD3776978E49DEEa2ea4e', decimals: 8, backs: 'BTC held by BitGo for WBTC' },
} as const satisfies Record<string, { network: Network; address: `0x${string}`; decimals: number; backs: string }>;
export type PorAsset = keyof typeof POR_REGISTRY;
export const POR_ASSETS = Object.keys(POR_REGISTRY) as [PorAsset, ...PorAsset[]];

/** ERC-20 tokens whose totalSupply() a policy may read, e.g. to compare against its reserve. */
export const TOKEN_REGISTRY = {
  WBTC: { network: 'ethereum-mainnet', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
} as const satisfies Record<string, { network: Network; address: `0x${string}`; decimals: number }>;
export type SupplyToken = keyof typeof TOKEN_REGISTRY;
export const SUPPLY_TOKENS = Object.keys(TOKEN_REGISTRY) as [SupplyToken, ...SupplyToken[]];

/**
 * Lending markets whose current supply rate a policy may read, straight from
 * the protocol contracts (no yield API: CRE caps HTTP responses at 250 KB and
 * a contract read agrees exactly across nodes at one block).
 */
export const LENDING_REGISTRY = {
  'aave-v3': { label: 'Aave v3', network: 'ethereum-mainnet', address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', assets: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
  'compound-v3': { label: 'Compound v3', network: 'ethereum-mainnet', address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', assets: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
} as const satisfies Record<string, { label: string; network: Network; address: `0x${string}`; assets: Record<string, `0x${string}`> }>;
export type LendingProtocol = keyof typeof LENDING_REGISTRY;
export const LENDING_PROTOCOLS = Object.keys(LENDING_REGISTRY) as [LendingProtocol, ...LendingProtocol[]];
export const LENDING_ASSETS = ['USDC'] as const;

/** CCIP lanes an evacuation may use. The vault also pins its one destination at deploy. */
export const CCIP_DESTINATIONS = {
  'base-sepolia': { chainSelector: '10344971235874465080', chainId: 84532, label: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
} as const;
export type CcipDestination = keyof typeof CCIP_DESTINATIONS;
export const CCIP_DESTINATION_IDS = Object.keys(CCIP_DESTINATIONS) as [CcipDestination, ...CcipDestination[]];
/** Chainlink's CCIP deployment on Ethereum Sepolia (from @chainlink/local's network register). */
export const CCIP_SEPOLIA = { router: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59', bnm: '0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05', link: '0x779877A7B0D9E8603169DdbD7836e478b4624789' } as const;
export const ccipExplorer = (messageId: string) => `https://ccip.chain.link/msg/${messageId}`;

const exchangeTradeSchema = z.object({ type: z.literal('exchange-trade'), pair: z.literal('ETH-USD', { errorMap: () => ({ message: 'Only the Coinbase ETH-USD trade is an exchange source; use a chainlink-feed source for other assets' }) }) }).strict();
const chainlinkFeedSchema = z.object({
  type: z.literal('chainlink-feed'),
  symbol: z.enum(FEED_SYMBOLS),
  network: z.enum(NETWORK_IDS).default(DEFAULT_FEED_NETWORK),
}).strict();
const proofOfReserveSchema = z.object({ type: z.literal('proof-of-reserve'), asset: z.enum(POR_ASSETS) }).strict();
const tokenSupplySchema = z.object({ type: z.literal('token-supply'), token: z.enum(SUPPLY_TOKENS) }).strict();
const lendingRateSchema = z.object({ type: z.literal('lending-rate'), protocol: z.enum(LENDING_PROTOCOLS), asset: z.enum(LENDING_ASSETS) }).strict();
const vaultBalanceSchema = z.object({ type: z.literal('vault-balance') }).strict();

/** Price sources: what a `price` node reads (the original vocabulary). */
export const priceSourceSchema = z.discriminatedUnion('type', [exchangeTradeSchema, chainlinkFeedSchema]);
/** Every source a `reading` node may read. */
export const sourceSchema = z.discriminatedUnion('type', [exchangeTradeSchema, chainlinkFeedSchema, proofOfReserveSchema, tokenSupplySchema, lendingRateSchema, vaultBalanceSchema]);
export type PriceSource = z.infer<typeof priceSourceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type FeedSource = Extract<Source, { type: 'chainlink-feed' }>;
export type ChainSource = Exclude<Source, { type: 'exchange-trade' } | { type: 'vault-balance' }>;

export const sourceKey = (source: Source): string => {
  switch (source.type) {
    case 'exchange-trade': return `exchange-trade:${source.pair}`;
    case 'chainlink-feed': return `chainlink-feed:${source.network}:${source.symbol}`;
    case 'proof-of-reserve': return `proof-of-reserve:${POR_REGISTRY[source.asset].network}:${source.asset}`;
    case 'token-supply': return `token-supply:${TOKEN_REGISTRY[source.token].network}:${source.token}`;
    case 'lending-rate': return `lending-rate:${LENDING_REGISTRY[source.protocol].network}:${source.protocol}:${source.asset}`;
    case 'vault-balance': return 'vault-balance';
  }
};
export const describeSource = (source: Source): string => {
  switch (source.type) {
    case 'exchange-trade': return `Coinbase ${source.pair} trade`;
    case 'chainlink-feed': return `Chainlink ${source.symbol}/USD (${source.network === 'ethereum-mainnet' ? 'mainnet' : 'Sepolia'})`;
    case 'proof-of-reserve': return `Chainlink ${source.asset} Proof of Reserve`;
    case 'token-supply': return `${source.token} total supply`;
    case 'lending-rate': return `${LENDING_REGISTRY[source.protocol].label} ${source.asset} supply APR`;
    case 'vault-balance': return 'vault ETH balance';
  }
};
/** Price sources can be read by either node kind; the rest only by `reading`. */
export const isPriceSource = (source: Source): source is PriceSource => source.type === 'exchange-trade' || source.type === 'chainlink-feed';

/** Where a reading must come from. Part of the policy hash and of every observation. */
export interface SourceIdentity {
  key: string;
  provider: 'coinbase' | 'chainlink' | 'aave' | 'compound' | 'erc20' | 'vault';
  label: string;
  /** Unit of the value: USD, %, or the asset an amount is denominated in. */
  unit: string;
  network?: Network;
  chainId?: number;
  address?: `0x${string}`;
  /** Lending: the underlying asset whose rate is read. */
  asset?: `0x${string}`;
  decimals?: number;
  url?: string;
}
export const EXCHANGE_TRADE_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/ticker';
export function sourceIdentity(source: Source): SourceIdentity {
  const base = { key: sourceKey(source), label: describeSource(source) };
  switch (source.type) {
    case 'exchange-trade':
      return { ...base, provider: 'coinbase', unit: 'USD', url: EXCHANGE_TRADE_URL };
    case 'chainlink-feed': {
      const address = feedAddress(source.network, source.symbol);
      if (!address) throw new Error(`No Chainlink ${source.symbol}/USD feed is configured on ${NETWORKS[source.network].label}; available there: ${Object.keys(FEED_REGISTRY[source.network]).join(', ')}`);
      return { ...base, provider: 'chainlink', unit: 'USD', network: source.network, chainId: NETWORKS[source.network].chainId, address, decimals: FEED_DECIMALS };
    }
    case 'proof-of-reserve': {
      const entry = POR_REGISTRY[source.asset];
      return { ...base, provider: 'chainlink', unit: source.asset, network: entry.network, chainId: NETWORKS[entry.network].chainId, address: entry.address, decimals: entry.decimals };
    }
    case 'token-supply': {
      const entry = TOKEN_REGISTRY[source.token];
      return { ...base, provider: 'erc20', unit: source.token, network: entry.network, chainId: NETWORKS[entry.network].chainId, address: entry.address, decimals: entry.decimals };
    }
    case 'lending-rate': {
      const entry = LENDING_REGISTRY[source.protocol];
      return { ...base, provider: source.protocol === 'aave-v3' ? 'aave' : 'compound', unit: '%', network: entry.network, chainId: NETWORKS[entry.network].chainId, address: entry.address, asset: entry.assets[source.asset] };
    }
    case 'vault-balance':
      return { ...base, provider: 'vault', unit: 'ETH' };
  }
}

// ---------------------------------------------------------------------------
// Graph shape
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
export const COMPARATORS = ['<', '<=', '>', '>='] as const;
export const MATH_OPS = ['-', '/', '*'] as const;

/** USD amounts compare as integers at 1e-8, the precision of Chainlink USD feeds. */
export const USD_SCALE = 100_000_000;
export const toUsdUnits = (usd: number): number => Math.round(usd * USD_SCALE);
/** Thresholds carry at most 8 decimals, so the hash and the comparison see the same number. */
const threshold = z.number().finite().min(-1e15).max(1e15)
  .refine((value) => Math.abs(value) >= 1e7 || toUsdUnits(value) / USD_SCALE === value, 'Thresholds may use at most 8 decimal places');
const timestamp = z.string().datetime({ offset: true })
  .refine((value) => { const t = Date.parse(value); return t >= Date.parse('2020-01-01T00:00:00Z') && t <= Date.parse('2100-01-01T00:00:00Z'); }, 'Time must be between 2020 and 2100');

export const graphNodeSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('price'), source: priceSourceSchema }).strict(),
  z.object({ id, kind: z.literal('reading'), source: sourceSchema }).strict(),
  z.object({ id, kind: z.literal('math'), op: z.enum(MATH_OPS), left: id, right: id }).strict(),
  z.object({ id, kind: z.literal('compare'), input: id, op: z.enum(COMPARATORS), value: threshold }).strict(),
  z.object({ id, kind: z.literal('freshness'), input: id, maxAgeSeconds: z.number().int().min(1).max(86400) }).strict(),
  z.object({ id, kind: z.literal('vault-paused'), equals: z.boolean() }).strict(),
  z.object({ id, kind: z.literal('time'), op: z.enum(['before', 'after']), at: timestamp }).strict(),
  z.object({ id, kind: z.literal('and'), inputs: z.array(id).min(2).max(8) }).strict(),
  z.object({ id, kind: z.literal('or'), inputs: z.array(id).min(2).max(8) }).strict(),
  z.object({ id, kind: z.literal('not'), input: id }).strict(),
]);
export type GraphNode = z.infer<typeof graphNodeSchema>;
type SourceNode = Extract<GraphNode, { kind: 'price' | 'reading' }>;
export const isSourceNode = (node: GraphNode): node is SourceNode => node.kind === 'price' || node.kind === 'reading';

/** A share of a balance, as a whole number of basis points (0.25 = 2,500 bps). */
const fraction = z.number().gt(0).max(1)
  .refine((value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-9, 'Use a fraction with at most 4 decimals, e.g. 0.25 for a quarter');
export const toBps = (value: number): number => Math.round(value * 10_000);
/** Payment sizes are whole gwei, so the hash and the transfer agree exactly. */
const ethAmount = z.number().gt(0).max(10)
  .refine((value) => value >= 1e-9 && Math.abs(value * 1e9 - Math.round(value * 1e9)) < 1e-6, 'Use at most 9 decimal places of ETH');
export const toGwei = (eth: number): bigint => BigInt(Math.round(eth * 1e9));
export const PAYEE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Terminal actions.
 * - Real, delivered to GrantVault as a signed report: pause-vault, sweep (move a
 *   share of the vault to the reserve fixed at deploy), pay (a payee the owner
 *   registered, capped and rate-limited by the contract), evacuate (bridge a
 *   share of the vault's CCIP-BnM to the reserve on another chain via CCIP).
 * - Simulated, local rehearsal only, never a transaction: sell, rebalance. Any
 *   surface showing their result has to say simulated.
 */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause-vault') }).strict(),
  z.object({
    type: z.literal('sell'),
    symbol: z.enum(FEED_SYMBOLS),
    amount: z.number().positive().max(1e9),
    venue: z.literal('mock-venue').default('mock-venue'),
  }).strict(),
  z.object({
    type: z.literal('rebalance'),
    from: z.enum(LENDING_PROTOCOLS),
    to: z.enum(LENDING_PROTOCOLS),
    asset: z.enum(LENDING_ASSETS).default('USDC'),
    fraction,
  }).strict(),
  z.object({ type: z.literal('sweep'), fraction, pause: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('pay'), payee: z.string().regex(PAYEE_PATTERN, 'Payee is a registered name such as "grantee"'), amountEth: ethAmount }).strict(),
  z.object({ type: z.literal('evacuate'), destination: z.enum(CCIP_DESTINATION_IDS), fraction, pause: z.boolean().default(true) }).strict(),
]);
export type PolicyAction = z.infer<typeof actionSchema>;
export type SimulatedAction = Extract<PolicyAction, { type: 'sell' | 'rebalance' }>;
export type VaultAction = Exclude<PolicyAction, SimulatedAction>;
export const isSimulatedAction = (action: PolicyAction): action is SimulatedAction => action.type === 'sell' || action.type === 'rebalance';
/** Pauses spending as part of the action. */
export const actionPauses = (action: PolicyAction): boolean =>
  action.type === 'pause-vault' || ((action.type === 'sweep' || action.type === 'evacuate') && action.pause);

export const policyGraphSchema = z.object({
  nodes: z.array(graphNodeSchema).min(1).max(40),
  root: id,
  action: actionSchema,
}).strict();
export type PolicyGraph = z.infer<typeof policyGraphSchema>;
/** Accepts graphs written before feed sources carried a network. */
export type PolicyGraphInput = z.input<typeof policyGraphSchema>;

/**
 * CRE allows 15 EVM reads and 15 HTTP calls per execution. A run reads the
 * vault up to four times and each source at most twice (Compound's rate needs
 * utilisation first), so five distinct sources keep every graph inside quota.
 */
export const MAX_SOURCES = 5;

// ---------------------------------------------------------------------------
// Units. Every number in a graph has one, so a policy cannot subtract a
// percentage from a dollar price or compare a ratio against a token amount.
// ---------------------------------------------------------------------------

export type Unit =
  | { dim: 'usd'; per?: string }
  | { dim: 'amount'; asset: string }
  | { dim: 'percent' }
  | { dim: 'ratio' };
type ValueType = 'bool' | Unit;

export function unitOfSource(source: Source): Unit {
  switch (source.type) {
    case 'exchange-trade': return { dim: 'usd', per: 'ETH' };
    case 'chainlink-feed': return { dim: 'usd', per: source.symbol };
    case 'proof-of-reserve': return { dim: 'amount', asset: source.asset };
    case 'token-supply': return { dim: 'amount', asset: source.token };
    case 'lending-rate': return { dim: 'percent' };
    case 'vault-balance': return { dim: 'amount', asset: 'ETH' };
  }
}
const unitName = (unit: Unit): string =>
  unit.dim === 'usd' ? (unit.per ? `a USD price of ${unit.per}` : 'a USD amount') : unit.dim === 'amount' ? `an amount of ${unit.asset}` : unit.dim === 'percent' ? 'a percentage' : 'a ratio';
const sameDimension = (a: Unit, b: Unit) => a.dim === b.dim && (a.dim !== 'amount' || a.asset === (b as { asset: string }).asset);

/** Formats a number in its unit, for narration and evidence. */
export function formatValue(value: number, unit: Unit): string {
  if (!Number.isFinite(value)) return String(value);
  const plain = (digits: number) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
  if (unit.dim === 'usd') return formatUsd(value);
  if (unit.dim === 'percent') return `${plain(4)}%`;
  if (unit.dim === 'ratio') return plain(6);
  return `${plain(8)} ${unit.asset}`;
}
/** Shows enough decimals for stablecoin thresholds without padding large prices. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const digits = Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : 8;
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  return `${value < 0 ? '-' : ''}$${text}`;
}
/** A threshold as the speaker would say it: "$3,000", "0.5%", "1", "120 WBTC". */
function formatThreshold(value: number, unit: Unit | undefined): string {
  const plain = value.toLocaleString('en-US', { maximumFractionDigits: 8 });
  if (!unit || unit.dim === 'usd') return value < 0 ? `-$${plain.slice(1)}` : `$${plain}`;
  if (unit.dim === 'percent') return `${plain}%`;
  if (unit.dim === 'ratio') return plain;
  return `${plain} ${unit.asset}`;
}

const inputsOf = (node: GraphNode): string[] =>
  node.kind === 'and' || node.kind === 'or' ? node.inputs
    : node.kind === 'compare' || node.kind === 'freshness' || node.kind === 'not' ? [node.input]
    : node.kind === 'math' ? [node.left, node.right]
    : [];
export const nodeInputs = inputsOf;

/** Types every node, or throws the first well-typedness error. */
function typeGraph(graph: PolicyGraph): Map<string, ValueType> {
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
  const describeType = (type: ValueType) => type === 'bool' ? 'a condition' : type.dim === 'usd' && type.per ? 'a price' : 'a value';
  const typeOf = (nodeId: string): ValueType => {
    const seen = state.get(nodeId);
    if (seen === 'done') return types.get(nodeId)!;
    if (seen === 'visiting') throw new Error(`Graph contains a cycle through "${nodeId}"`);
    state.set(nodeId, 'visiting');
    const node = byId.get(nodeId)!;
    let type: ValueType;
    switch (node.kind) {
      case 'price':
      case 'reading':
        type = unitOfSource(node.source);
        break;
      case 'vault-paused':
      case 'time':
        type = 'bool';
        break;
      case 'compare': {
        const input = typeOf(node.input);
        if (input === 'bool') throw new Error(`"${node.id}" (compare) needs a price or value node, but "${node.input}" is a condition`);
        type = 'bool';
        break;
      }
      case 'freshness': {
        const input = byId.get(node.input)!;
        if (typeOf(node.input) === 'bool') throw new Error(`"${node.id}" (freshness) needs a price or reading node, but "${node.input}" is a condition`);
        if (!isSourceNode(input)) throw new Error(`"${node.id}" (freshness) needs a source reading with its own timestamp, but "${node.input}" is a ${input.kind} result`);
        type = 'bool';
        break;
      }
      case 'math': {
        const [left, right] = [typeOf(node.left), typeOf(node.right)];
        if (left === 'bool' || right === 'bool')
          throw new Error(`"${node.id}" (math ${node.op}) needs values, but "${left === 'bool' ? node.left : node.right}" is a condition`);
        if (node.op === '*') {
          if (left.dim === 'ratio') type = right.dim === 'usd' ? { dim: 'usd' } : right;
          else if (right.dim === 'ratio') type = left.dim === 'usd' ? { dim: 'usd' } : left;
          else if (left.dim === 'amount' && right.dim === 'usd' && right.per === left.asset) type = { dim: 'usd' };
          else if (right.dim === 'amount' && left.dim === 'usd' && left.per === right.asset) type = { dim: 'usd' };
          else throw new Error(`"${node.id}" (math *) can multiply an amount by its own USD price (vault ETH × ETH/USD) or anything by a ratio, not ${unitName(left)} by ${unitName(right)}`);
        } else {
          if (!sameDimension(left, right))
            throw new Error(`"${node.id}" (math ${node.op}) needs two values in the same unit, but got ${unitName(left)} and ${unitName(right)}`);
          type = node.op === '/' ? { dim: 'ratio' } : left.dim === 'usd' ? { dim: 'usd' } : left;
        }
        break;
      }
      default: {
        const refs = inputsOf(node);
        if (new Set(refs).size !== refs.length) throw new Error(`"${node.id}" (${node.kind}) lists the same input twice`);
        for (const ref of refs) {
          const refType = typeOf(ref);
          if (refType !== 'bool') throw new Error(`"${node.id}" (${node.kind}) needs conditions, but "${ref}" is ${describeType(refType)}`);
        }
        type = 'bool';
      }
    }
    state.set(nodeId, 'done');
    types.set(nodeId, type);
    return type;
  };
  for (const node of graph.nodes) typeOf(node.id);
  return types;
}

/**
 * Static check: unique ids, resolvable edges, no cycles, well-typed operands
 * with compatible units, a boolean root, every node connected to that root,
 * every source in its registry, and a bounded fetch plan. Every execution
 * boundary calls this; evaluation assumes a graph that has passed it.
 */
export function validateGraph(input: unknown): { graph: PolicyGraph; types: Map<string, ValueType> } {
  const graph = policyGraphSchema.parse(input);
  const types = typeGraph(graph);
  if (types.get(graph.root) !== 'bool')
    throw new Error(`Root "${graph.root}" must be a condition, not a price reading`);

  // A node the root never reaches would be displayed and fetched without
  // deciding anything. Refuse it so the canvas and the evaluator agree.
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
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
  if (graph.action.type === 'rebalance' && graph.action.from === graph.action.to)
    throw new Error('A rebalance needs two different protocols');
  return { graph, types };
}

/** Every distinct source a graph needs fetched, deduplicated, in first-use order. */
export function collectSources(graph: PolicyGraph): Source[] {
  const seen = new Map<string, Source>();
  for (const node of graph.nodes)
    if (isSourceNode(node)) seen.set(sourceKey(node.source), node.source);
  return [...seen.values()];
}

/** True when execution must read the vault: an action targets it, or a condition or reading uses it. */
export const readsVault = (graph: PolicyGraph): boolean =>
  !isSimulatedAction(graph.action) || graph.nodes.some((node) => node.kind === 'vault-paused' || (isSourceNode(node) && node.source.type === 'vault-balance'));

// ---------------------------------------------------------------------------
// Policy identity. The hash is structural: node ids and declaration order do
// not change it, AND/OR operands are order-free, and every source is bound to
// its network and contract address. The report and the receiver event carry it.
// ---------------------------------------------------------------------------

/** The exchange-trade freshness cap a run uses when the policy doesn't set one. */
export const DEFAULT_EXCHANGE_MAX_AGE_SECONDS = 60;
/** Text of the action inside the policy hash. Pause and sell keep their original forms. */
export function actionIdentity(action: PolicyAction): string {
  switch (action.type) {
    case 'pause-vault': return 'pause-vault';
    case 'sell': return `sell(${action.symbol},${action.amount},${action.venue})`;
    case 'rebalance': return `rebalance(${action.from},${action.to},${action.asset},${toBps(action.fraction)})`;
    case 'sweep': return `sweep(${toBps(action.fraction)},${action.pause})`;
    case 'pay': return `pay(${action.payee},${toGwei(action.amountEth)})`;
    case 'evacuate': return `evacuate(${CCIP_DESTINATIONS[action.destination].chainSelector},${toBps(action.fraction)},${action.pause})`;
  }
}
/**
 * The exchange cap changes decisions, so a non-default cap is part of the
 * identity. The default is left out so hashes recorded before this rule
 * (all at 60 s) still verify.
 */
export function policyHash(input: PolicyGraphInput | PolicyGraph, exchangeMaxAgeSeconds: number = DEFAULT_EXCHANGE_MAX_AGE_SECONDS): Hex {
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
      case 'price':
      case 'reading': {
        // A price source hashes the same whichever node kind reads it.
        const identity = sourceIdentity(node.source);
        const bound = `${identity.key}${identity.address ? `@${identity.address.toLowerCase()}` : ''}${identity.asset ? `/${identity.asset.toLowerCase()}` : ''}`;
        text = isPriceSource(node.source) ? `price(${bound})` : `reading(${bound})`;
        break;
      }
      case 'math': {
        const operands = [hashOf(node.left), hashOf(node.right)];
        text = `math(${node.op},${(node.op === '*' ? operands.sort() : operands).join(',')})`;
        break;
      }
      case 'compare': text = `compare(${node.op},${toUsdUnits(node.value)},${hashOf(node.input)})`; break;
      case 'freshness': text = `freshness(${node.maxAgeSeconds},${hashOf(node.input)})`; break;
      case 'vault-paused': text = `vault-paused(${node.equals})`; break;
      case 'time': text = `time(${node.op},${Math.floor(Date.parse(node.at) / 1000)})`; break;
      case 'not': text = `not(${hashOf(node.input)})`; break;
      default: text = `${node.kind}(${[...new Set(node.inputs.map(hashOf))].sort().join(',')})`;
    }
    const value = digest(text);
    memo.set(nodeId, value);
    return value;
  };
  const usesExchange = graph.nodes.some((node) => isSourceNode(node) && node.source.type === 'exchange-trade');
  const cap = usesExchange && exchangeMaxAgeSeconds !== DEFAULT_EXCHANGE_MAX_AGE_SECONDS ? `|exchange-max-age(${exchangeMaxAgeSeconds})` : '';
  return digest(`sotto-policy/v${GRAPH_VERSION}|${hashOf(graph.root)}|${actionIdentity(graph.action)}${cap}`);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** One resolved input. `usd` is accepted from callers written before non-USD readings. */
export interface Reading { value?: number; usd?: number; observedAt: string }
/** @deprecated use Reading */
export type PriceReading = Reading;
/** One archived input. Everything needed to re-check the decision later. */
export interface Observation extends SourceIdentity {
  /** The reading in `unit`. */
  value: number;
  /** Same as value, present only for USD prices. */
  usd?: number;
  /** Raw integer answer for contract reads; exact string for exchange trades. */
  raw: string;
  observedAt: string;
  fetchedAt: string;
  roundId?: string;
}
/** Exchange trades must be this fresh at most; a run can tighten it but never relax it. */
export const MAX_EXCHANGE_AGE_SECONDS = 120;
/**
 * Data Feeds (prices and Proof of Reserve) update on deviation or a heartbeat
 * of up to 24 hours. A reading older than one missed heartbeat plus margin
 * means the feed is not updating.
 */
export const MAX_FEED_AGE_SECONDS = 26 * 3600;
/** Contract state (supply, lending rate, vault balance) is read during the run itself. */
export const MAX_STATE_AGE_SECONDS = 300;
/** Tolerated clock disagreement before a timestamp counts as "from the future". */
export const MAX_FUTURE_SKEW_SECONDS = 30;

export interface GraphInputs {
  /** Keyed by sourceKey(). Must cover every source collectSources() reports. */
  readings: Record<string, Reading>;
  /** Fresh vault read; null when the graph neither targets nor reads the vault. */
  vaultPaused: boolean | null;
  /** Vault ETH balance, needed by sweep and pay guards. */
  vaultBalanceEth?: number | null;
  /** Vault CCIP-BnM balance, needed by the evacuate guard. */
  vaultTokenBalance?: number | null;
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
const compareScaled = (left: number, op: (typeof COMPARATORS)[number], right: number): boolean => {
  const a = toUsdUnits(left), b = toUsdUnits(right);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
};
/** How old a source may be: the run's exchange cap, a feed heartbeat, or a same-run contract read. */
export const sourceAgeLimit = (source: Source, exchangeMaxAgeSeconds: number): number =>
  source.type === 'exchange-trade' ? Math.min(Math.max(1, Math.floor(exchangeMaxAgeSeconds)), MAX_EXCHANGE_AGE_SECONDS)
    : source.type === 'chainlink-feed' || source.type === 'proof-of-reserve' ? MAX_FEED_AGE_SECONDS
    : MAX_STATE_AGE_SECONDS;
const formatTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');

type NumberValue = { value: number; unit: Unit };

/**
 * Pure evaluation shared by every execution path. Sources are resolved by the
 * caller; a missing reading throws rather than counting as false (which a NOT
 * would turn into true).
 *
 * Mandatory guards are appended whether or not the graph expresses them:
 * every source within its freshness limit and, per action, the vault state
 * that makes it meaningful (not already paused for a pause, funds for a
 * sweep or payment, tokens for an evacuation). Only the root and these guards
 * gate the action, so a false branch inside a passing OR is not a failure.
 */
export function evaluateGraph(graph: PolicyGraph, inputs: GraphInputs, nowMs: number): GraphResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const types = typeGraph(graph);
  const conditions: ConditionEvidence[] = [];
  const memo = new Map<string, boolean | NumberValue>();
  const reading = (source: Source): { value: number; observedAt: string } => {
    const entry = inputs.readings[sourceKey(source)];
    const value = entry?.value ?? entry?.usd;
    const valid = entry && typeof value === 'number' && Number.isFinite(value) && (isPriceSource(source) ? value > 0 : value >= 0) && Number.isFinite(Date.parse(entry.observedAt));
    if (!valid) throw new Error(`Missing resolved reading for ${describeSource(source)}`);
    return { value: value!, observedAt: entry!.observedAt };
  };
  const label = (nodeId: string): string => {
    const node = byId.get(nodeId)!;
    if (isSourceNode(node)) return describeSource(node.source);
    if (node.kind === 'math') return `(${label(node.left)} ${node.op === '-' ? '−' : node.op === '/' ? '÷' : '×'} ${label(node.right)})`;
    return phraseCondition(graph, nodeId);
  };

  const value = (nodeId: string): boolean | NumberValue => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    const node = byId.get(nodeId);
    if (!node) throw new Error(`Unknown node "${nodeId}"`);
    let result: boolean | NumberValue;
    switch (node.kind) {
      case 'price':
      case 'reading':
        result = { value: reading(node.source).value, unit: types.get(node.id) as Unit };
        break;
      case 'math': {
        const left = value(node.left) as NumberValue, right = value(node.right) as NumberValue;
        if (node.op === '/' && right.value === 0) throw new Error(`${label(node.right)} is zero, so ${label(node.id)} is undefined`);
        const computed = node.op === '-' ? left.value - right.value : node.op === '/' ? left.value / right.value : left.value * right.value;
        result = { value: computed, unit: types.get(node.id) as Unit };
        break;
      }
      case 'compare': {
        const input = value(node.input) as NumberValue;
        const passed = compareScaled(input.value, node.op, node.value);
        result = passed;
        conditions.push({ nodeId: node.id, kind: 'threshold', role: 'node', passed, detail: `${label(node.input)} ${formatValue(input.value, input.unit)} ${node.op} ${formatValue(node.value, input.unit)}` });
        break;
      }
      case 'freshness': {
        const source = (byId.get(node.input) as SourceNode).source;
        const age = ageSeconds(reading(source).observedAt, nowMs);
        result = withinAge(age, node.maxAgeSeconds);
        conditions.push({ nodeId: node.id, kind: 'freshness', role: 'node', passed: result, detail: `${describeSource(source)} observed ${age.toFixed(1)}s ago; maximum ${node.maxAgeSeconds}s` });
        break;
      }
      case 'vault-paused':
        if (inputs.vaultPaused === null) throw new Error('Policy reads vault state but no vault read was supplied');
        result = inputs.vaultPaused === node.equals;
        conditions.push({ nodeId: node.id, kind: 'vault-state', role: 'node', passed: result, detail: `Vault is ${inputs.vaultPaused ? 'paused' : 'active'}; condition wants ${node.equals ? 'paused' : 'active'}` });
        break;
      case 'time': {
        const at = Date.parse(node.at);
        result = node.op === 'before' ? nowMs < at : nowMs >= at;
        conditions.push({ nodeId: node.id, kind: 'time', role: 'node', passed: result, detail: `Decided at ${formatTime(new Date(nowMs).toISOString())}; condition wants ${node.op} ${formatTime(node.at)}` });
        break;
      }
      case 'not': {
        result = !(value(node.input) as boolean);
        conditions.push({ nodeId: node.id, kind: 'not', role: 'node', passed: result, detail: `not (${label(node.input)}) → ${result}` });
        break;
      }
      default: {
        const parts = node.inputs.map((ref) => value(ref) as boolean);
        result = node.kind === 'and' ? parts.every(Boolean) : parts.some(Boolean);
        conditions.push({ nodeId: node.id, kind: node.kind, role: 'node', passed: result, detail: `${parts.filter(Boolean).length} of ${parts.length} conditions held (${node.kind === 'and' ? 'all' : 'any'} needed) → ${result}` });
      }
    }
    memo.set(nodeId, result);
    return result;
  };

  const root = value(graph.root) as boolean;
  const gates: ConditionEvidence[] = [
    { nodeId: 'guard:root', kind: 'composed-policy', role: 'root', passed: root, detail: `Policy condition evaluated ${root}` },
  ];
  for (const source of collectSources(graph)) {
    const limit = sourceAgeLimit(source, inputs.exchangeMaxAgeSeconds);
    const age = ageSeconds(reading(source).observedAt, nowMs);
    gates.push({
      nodeId: `guard:source:${sourceKey(source)}`, kind: 'source-freshness', role: 'guard', passed: withinAge(age, limit),
      detail: age < -MAX_FUTURE_SKEW_SECONDS
        ? `${describeSource(source)} timestamp is ${(-age).toFixed(0)}s in the future`
        : `${describeSource(source)} observed ${age.toFixed(1)}s ago; limit ${limit}s`,
    });
  }
  gates.push(...actionGuards(graph.action, inputs));
  const blockedBy = gates.find((gate) => !gate.passed);
  return { conditions: [...conditions, ...gates], root, decision: blockedBy ? 'noop' : 'act', ...(blockedBy ? { blockedBy } : {}) };
}

/** The vault state each real action needs before a report is worth sending. */
function actionGuards(action: PolicyAction, inputs: GraphInputs): ConditionEvidence[] {
  if (isSimulatedAction(action)) return [];
  if (inputs.vaultPaused === null) throw new Error(`A vault ${action.type === 'pause-vault' ? 'pause' : action.type} needs a fresh vault read`);
  const balance = () => {
    if (typeof inputs.vaultBalanceEth !== 'number' || !Number.isFinite(inputs.vaultBalanceEth)) throw new Error(`A vault ${action.type} needs a fresh vault balance read`);
    return inputs.vaultBalanceEth;
  };
  switch (action.type) {
    case 'pause-vault':
      return [{ nodeId: 'guard:vault-active', kind: 'vault-state', role: 'guard', passed: !inputs.vaultPaused, detail: inputs.vaultPaused ? 'Vault already paused; no second pause needed' : 'Vault spending active' }];
    case 'sweep': {
      const eth = balance();
      return [{ nodeId: 'guard:vault-funds', kind: 'vault-funds', role: 'guard', passed: eth > 0, detail: eth > 0 ? `Vault holds ${eth} ETH; sweeping ${toBps(action.fraction) / 100}% to the reserve` : 'Vault holds no ETH to sweep' }];
    }
    case 'pay': {
      const eth = balance();
      return [
        { nodeId: 'guard:vault-active', kind: 'vault-state', role: 'guard', passed: !inputs.vaultPaused, detail: inputs.vaultPaused ? 'Vault spending is paused; no payment is made' : 'Vault spending active' },
        { nodeId: 'guard:vault-funds', kind: 'vault-funds', role: 'guard', passed: eth >= action.amountEth, detail: eth >= action.amountEth ? `Vault holds ${eth} ETH for a ${action.amountEth} ETH payment` : `Vault holds ${eth} ETH, less than the ${action.amountEth} ETH payment` },
      ];
    }
    case 'evacuate': {
      const tokens = inputs.vaultTokenBalance;
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) throw new Error('An evacuation needs a fresh read of the vault token balance');
      return [{ nodeId: 'guard:vault-tokens', kind: 'vault-funds', role: 'guard', passed: tokens > 0, detail: tokens > 0 ? `Vault holds ${tokens} CCIP-BnM; bridging ${toBps(action.fraction) / 100}% via CCIP` : 'Vault holds no CCIP-BnM to evacuate' }];
    }
  }
}

/** Plain-language reason for a noop, from the gate that actually stopped it. */
export function explainNoop(result: GraphResult): string {
  const gate = result.blockedBy;
  if (!gate) return 'No action was needed.';
  if (gate.role === 'root') return 'The policy condition was not met.';
  if (gate.nodeId === 'guard:vault-active' && /already paused/.test(gate.detail)) return 'The vault was already paused, so no second pause was sent.';
  if (gate.kind === 'source-freshness') return `An input was too old or future-dated: ${gate.detail}.`;
  return `${gate.detail}.`;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const runIdHash = (runId: string): Hex => keccak256(toBytes(runId));
/** On-chain id of a registered payee: keccak256 of its name. */
export const payeeId = (name: string): Hex => keccak256(toBytes(name));
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex;

export interface PauseReport { target: `0x${string}`; chainId: number; runId: string; revision: number; policyHash: Hex; decidedAt: number }
/**
 * Report v2: (version, target, chainId, runIdHash, revision, policyHash, action, decidedAt).
 * Pause-only; still produced for vaults deployed before treasury actions.
 */
export function encodePauseReport(report: PauseReport): Hex {
  return encodeAbiParameters(
    parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256'),
    [BigInt(PAUSE_REPORT_VERSION), report.target, BigInt(report.chainId), runIdHash(report.runId), BigInt(report.revision), report.policyHash, BigInt(ACTION_PAUSE), BigInt(report.decidedAt)],
  );
}

/** Everything a v3 report carries beyond the shared identity fields. */
export interface ActionTerms { action: number; flags: number; payeeId: Hex; amount: bigint; destinationChainSelector: bigint }
/** The on-chain terms of a real action: what the receiver will do, in its own units. */
export function actionTerms(action: VaultAction): ActionTerms {
  const none = { flags: 0, payeeId: ZERO_BYTES32, amount: 0n, destinationChainSelector: 0n };
  switch (action.type) {
    case 'pause-vault': return { ...none, action: ACTION_PAUSE };
    case 'sweep': return { ...none, action: ACTION_SWEEP, flags: action.pause ? FLAG_PAUSE : 0, amount: BigInt(toBps(action.fraction)) };
    case 'pay': return { ...none, action: ACTION_PAY, payeeId: payeeId(action.payee), amount: toGwei(action.amountEth) * 1_000_000_000n };
    case 'evacuate': return { ...none, action: ACTION_EVACUATE, flags: action.pause ? FLAG_PAUSE : 0, amount: BigInt(toBps(action.fraction)), destinationChainSelector: BigInt(CCIP_DESTINATIONS[action.destination].chainSelector) };
  }
}
export type ActionReport = PauseReport & ActionTerms;
export const REPORT_V3_BYTES = 384;
/**
 * Report v3: v2's fields, then (flags, payeeId, amount, destinationChainSelector).
 * amount is basis points for sweep and evacuate, wei for pay. The receiver
 * checks forwarder, version, target, chain, action, replay and age, and caps
 * every movement with limits fixed at deploy.
 */
export function encodeActionReport(report: ActionReport): Hex {
  return encodeAbiParameters(
    parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256,uint256,bytes32,uint256,uint64'),
    [BigInt(REPORT_VERSION), report.target, BigInt(report.chainId), runIdHash(report.runId), BigInt(report.revision), report.policyHash, BigInt(report.action), BigInt(report.decidedAt), BigInt(report.flags), report.payeeId, report.amount, report.destinationChainSelector],
  );
}
/** Why a vault of this report version cannot take this action, or undefined when it can. */
export function reportRefusal(vaultReportVersion: number | null, actionType: VaultAction['type']): string | undefined {
  if (vaultReportVersion === REPORT_VERSION) return undefined;
  if (vaultReportVersion === PAUSE_REPORT_VERSION)
    return actionType === 'pause-vault' ? undefined
      : `this vault accepts pause reports only (v${PAUSE_REPORT_VERSION}); a ${actionType} needs a GrantVault v${REPORT_VERSION}. Redeploy with bun run deploy:sepolia. Nothing was submitted.`;
  return `accepts report ${vaultReportVersion ? `v${vaultReportVersion}` : 'v1'}, not v${PAUSE_REPORT_VERSION} or v${REPORT_VERSION}; redeploy the vault before running. Nothing was submitted.`;
}
/** The report a vault of the given version accepts for this action. Throws when there is none. */
export function encodeReportFor(vaultReportVersion: number | null, action: VaultAction, base: PauseReport): Hex {
  const refusal = reportRefusal(vaultReportVersion, action.type);
  if (refusal) throw new Error(`Vault ${base.target}: ${refusal}`);
  return vaultReportVersion === REPORT_VERSION ? encodeActionReport({ ...base, ...actionTerms(action) }) : encodePauseReport(base);
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

const percent = (fraction: number) => `${(toBps(fraction) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const protocolLabel = (protocol: LendingProtocol) => LENDING_REGISTRY[protocol].label;
export function describeAction(action: PolicyAction): string {
  switch (action.type) {
    case 'pause-vault': return 'Pause grant vault spending';
    case 'sell': return `Simulated sell of ${action.amount} ${action.symbol}`;
    case 'rebalance': return `Simulated rebalance of ${percent(action.fraction)} ${action.asset} from ${protocolLabel(action.from)} to ${protocolLabel(action.to)}`;
    case 'sweep': return `Sweep ${percent(action.fraction)} of the vault to the reserve${action.pause ? ' and pause spending' : ''}`;
    case 'pay': return `Pay ${action.amountEth} ETH to the ${action.payee}`;
    case 'evacuate': return `Bridge ${percent(action.fraction)} of the vault's CCIP-BnM to the reserve on ${CCIP_DESTINATIONS[action.destination].label} via CCIP${action.pause ? ' and pause spending' : ''}`;
  }
}
function actionSentence(action: PolicyAction): string {
  switch (action.type) {
    case 'pause-vault': return 'Pause spending';
    case 'sell': return `Submit a simulated sell of ${action.amount} ${action.symbol}`;
    case 'rebalance': return `Submit a simulated rebalance of ${percent(action.fraction)} of ${action.asset} from ${protocolLabel(action.from)} to ${protocolLabel(action.to)}`;
    default: return describeAction(action);
  }
}

/** Phrase of one node, for narration and condition labels. Shared subtrees are phrased in full. */
function phraser(graph: PolicyGraph): (nodeId: string) => string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  let types: Map<string, ValueType> | undefined;
  try { types = typeGraph(graph); } catch { types = undefined; }
  const memo = new Map<string, string>();
  const phrase = (nodeId: string): string => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    const node = byId.get(nodeId);
    let text: string;
    if (!node) text = nodeId;
    else switch (node.kind) {
      case 'price':
      case 'reading': text = describeSource(node.source); break;
      case 'math': text = `(${phrase(node.left)} ${node.op === '-' ? '−' : node.op === '/' ? '÷' : '×'} ${phrase(node.right)})`; break;
      case 'compare': {
        const unit = types?.get(node.input);
        text = `${phrase(node.input)} ${node.op} ${formatThreshold(node.value, unit === 'bool' ? undefined : unit)}`;
        break;
      }
      case 'freshness': text = `${phrase(node.input)} observed within ${node.maxAgeSeconds}s`; break;
      case 'vault-paused': text = `vault is ${node.equals ? 'paused' : 'active'}`; break;
      case 'time': text = `the time is ${node.op} ${formatTime(node.at)}`; break;
      case 'not': text = `not (${phrase(node.input)})`; break;
      default: text = `(${node.inputs.map(phrase).join(node.kind === 'and' ? ' and ' : ' or ')})`;
    }
    memo.set(nodeId, text);
    return text;
  };
  return phrase;
}
/** One node as a readable condition, e.g. "Chainlink BTC/USD (mainnet) < $90,000". */
export function phraseCondition(graph: PolicyGraph, nodeId: string): string {
  return phraser(graph)(nodeId);
}

/** One readable sentence per graph, for the agent's narration and the canvas. */
export function describeGraph(graph: PolicyGraph): string {
  return `${actionSentence(graph.action)} when ${phraser(graph)(graph.root)}.`;
}
