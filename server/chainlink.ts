import { createPublicClient, http, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import type { GraphObject } from "../shared/types";
import {
  FEED_REGISTRY,
  FEED_SYMBOLS,
  FEED_DECIMALS,
  NETWORKS,
  DEFAULT_FEED_NETWORK,
  sourceIdentity,
  type FeedSource,
  type FeedSymbol,
  type Network,
  type Observation,
} from "../cre/graph";

/**
 * Chainlink Data Feeds are plain on-chain aggregator proxies, so reading them
 * needs an RPC endpoint and nothing else. No Chainlink account or API key is
 * involved; that applies to Data Streams, which this does not use.
 *
 * Addresses live once, in cre/graph.ts, so the canvas, the policy hash, the
 * local runner and the CRE workflow all name the same aggregator.
 */
export interface FeedDefinition {
  symbol: string;
  name: string;
  address: Address;
}
const NAMES: Record<FeedSymbol, string> = {
  ETH: "Ethereum", BTC: "Bitcoin", LINK: "Chainlink", SOL: "Solana", BNB: "BNB",
  AVAX: "Avalanche", MATIC: "Polygon", AAVE: "Aave", UNI: "Uniswap", COMP: "Compound",
  MKR: "Maker", SNX: "Synthetix", CRV: "Curve DAO", USDC: "USD Coin", USDT: "Tether", DAI: "Dai",
};
const definitions = (network: Network): Record<string, FeedDefinition> =>
  Object.fromEntries(
    FEED_SYMBOLS.filter((symbol) => FEED_REGISTRY[network][symbol]).map((symbol) => [
      symbol,
      { symbol, name: NAMES[symbol], address: FEED_REGISTRY[network][symbol]! },
    ]),
  );
/** Mainnet feeds, the default network for reads and composed policies. */
export const CHAINLINK_FEEDS: Record<string, FeedDefinition> = definitions("ethereum-mainnet");
export const feedsOn = (network: Network = DEFAULT_FEED_NETWORK) => definitions(network);

/** Spoken and written forms the agent is likely to pass through verbatim. */
const ALIASES: Record<string, string> = {
  bitcoin: "BTC",
  xbt: "BTC",
  ether: "ETH",
  ethereum: "ETH",
  chainlink: "LINK",
  solana: "SOL",
  binance: "BNB",
  "binance coin": "BNB",
  avalanche: "AVAX",
  polygon: "MATIC",
  pol: "MATIC",
  aave: "AAVE",
  uniswap: "UNI",
  compound: "COMP",
  maker: "MKR",
  makerdao: "MKR",
  synthetix: "SNX",
  curve: "CRV",
  "curve dao": "CRV",
  "usd coin": "USDC",
  tether: "USDT",
  dai: "DAI",
};

export function listFeedSymbols(): string[] {
  return Object.keys(CHAINLINK_FEEDS);
}

/** Accepts "BTC", "btc", "bitcoin", "BTC/USD", "$BTC". Returns null when unknown. */
export function resolveFeedSymbol(input: string): FeedDefinition | null {
  const raw = input.trim().toLowerCase().replace(/^\$/, "").trim();
  // An exact symbol or name wins before any suffix is stripped, so "USDC" is
  // USD Coin rather than "USD" + "C".
  const lookup = (value: string) => CHAINLINK_FEEDS[value.toUpperCase()] ?? (ALIASES[value] ? CHAINLINK_FEEDS[ALIASES[value]!]! : null);
  if (!raw) return null;
  const exact = lookup(raw);
  if (exact) return exact;
  const cleaned = raw.replace(/[\/\-\s]*(usd|dollars?)$/, "").trim();
  return cleaned && cleaned !== raw ? lookup(cleaned) : null;
}

export const feedId = (symbol: string, network: Network = DEFAULT_FEED_NETWORK) =>
  `feed:${symbol.toLowerCase()}-usd${network === DEFAULT_FEED_NETWORK ? "" : `:${network.replace("ethereum-", "")}`}`;
/** Canvas object that displays a graph source's feed. */
export const feedObjectId = (source: FeedSource) => feedId(source.symbol, source.network);

const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const MAINNET_RPC =
  process.env.ORIGINS_MAINNET_RPC || "https://ethereum-rpc.publicnode.com";
export const SEPOLIA_RPC =
  process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";

const client = (network: Network) =>
  createPublicClient({
    chain: network === "ethereum-sepolia" ? sepolia : mainnet,
    transport: http(network === "ethereum-sepolia" ? SEPOLIA_RPC : MAINNET_RPC, { timeout: 12000 }),
  });

/** Human phrasing for how long ago the aggregator last wrote an answer. */
export function describeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown age";
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
}

/**
 * Read one feed's latest round. The returned object reports the aggregator's
 * own updatedAt as observedAt, never the fetch time: feeds publish on a
 * deviation threshold or heartbeat, so an honest answer is routinely minutes
 * old and the canvas has to say so.
 */
export async function fetchFeedPrice(
  input: string,
  network: Network = DEFAULT_FEED_NETWORK,
): Promise<GraphObject> {
  const known = resolveFeedSymbol(input);
  const feed = known && feedsOn(network)[known.symbol];
  if (!feed)
    throw new Error(
      `No Chainlink feed configured for "${input}" on ${NETWORKS[network].label}. Available: ${Object.keys(feedsOn(network)).join(", ")}`,
    );
  const rpc = client(network);
  const [description, decimals, round] = await Promise.all([
    rpc.readContract({
      address: feed.address,
      abi: aggregatorAbi,
      functionName: "description",
    }),
    rpc.readContract({
      address: feed.address,
      abi: aggregatorAbi,
      functionName: "decimals",
    }),
    rpc.readContract({
      address: feed.address,
      abi: aggregatorAbi,
      functionName: "latestRoundData",
    }),
  ]);
  const [roundId, answer, , updatedAt] = round;
  if (Number(decimals) !== FEED_DECIMALS)
    throw new Error(`${feed.symbol} feed reports ${decimals} decimals; the registry expects ${FEED_DECIMALS}`);
  if (answer <= 0n)
    throw new Error(`${feed.symbol} feed returned a non-positive answer`);
  if (updatedAt === 0n)
    throw new Error(`${feed.symbol} feed has no completed round`);
  const price = Number(answer) / 10 ** Number(decimals);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error(
      `${feed.symbol} feed answer did not decode to a usable price`,
    );
  const observedAt = new Date(Number(updatedAt) * 1000).toISOString();
  const ageSeconds = Date.now() / 1000 - Number(updatedAt);
  const net = NETWORKS[network];
  return {
    id: feedId(feed.symbol, network),
    kind: "feed",
    label: network === DEFAULT_FEED_NETWORK ? `${feed.symbol} / USD · Chainlink` : `${feed.symbol} / USD · Chainlink Sepolia`,
    visible: true,
    pinned: false,
    data: {
      price,
      unit: "USD",
      symbol: feed.symbol,
      name: feed.name,
      decimals: Number(decimals),
      answer: answer.toString(),
      roundId: roundId.toString(),
      ageSeconds: Math.round(ageSeconds),
      ageLabel: describeAge(ageSeconds),
      feedAddress: feed.address,
      description,
      network,
    },
    provenance: {
      source: "Chainlink Data Feed",
      url: `${net.explorer}/address/${feed.address}#readContract`,
      observedAt,
      fetchedAt: new Date().toISOString(),
      chainId: net.chainId,
      address: feed.address,
      kind: "chain",
      label: `Chainlink ${description} aggregator · ${net.label} · round ${roundId} written ${describeAge(ageSeconds)}`,
    },
  };
}

/** Archive form of a feed read, bound to the registry identity the policy hash uses. */
export function feedObservation(object: GraphObject, source: FeedSource): Observation {
  const identity = sourceIdentity(source);
  const address = String(object.data.feedAddress || object.provenance.address || "");
  if (object.kind !== "feed" || address.toLowerCase() !== identity.address!.toLowerCase())
    throw new Error(`Feed read for ${identity.label} came from ${address || "an unknown address"}, not ${identity.address}`);
  const usd = Number(object.data.price);
  return {
    ...identity,
    value: usd,
    usd,
    raw: String(object.data.answer ?? Math.round(usd * 10 ** FEED_DECIMALS)),
    ...(object.data.roundId ? { roundId: String(object.data.roundId) } : {}),
    observedAt: object.provenance.observedAt,
    fetchedAt: object.provenance.fetchedAt,
  };
}
