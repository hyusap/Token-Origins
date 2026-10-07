import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import type { GraphObject } from "../shared/types";

/**
 * Chainlink Data Feeds are plain on-chain aggregator proxies, so reading them
 * needs an RPC endpoint and nothing else. No Chainlink account or API key is
 * involved; that applies to Data Streams, which this does not use.
 *
 * Every address below was verified against mainnet by calling description()
 * and comparing it to the expected pair. Candidates whose description did not
 * match, or that failed to answer, were dropped rather than guessed at.
 */
export interface FeedDefinition {
  symbol: string;
  name: string;
  address: Address;
}
export const CHAINLINK_FEEDS: Record<string, FeedDefinition> = {
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    address: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
  },
  LINK: {
    symbol: "LINK",
    name: "Chainlink",
    address: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c",
  },
  SOL: {
    symbol: "SOL",
    name: "Solana",
    address: "0x4ffC43a60e009B551865A93d232E33Fce9f01507",
  },
  BNB: {
    symbol: "BNB",
    name: "BNB",
    address: "0x14e613AC84a31f709eadbdF89C6CC390fDc9540A",
  },
  AVAX: {
    symbol: "AVAX",
    name: "Avalanche",
    address: "0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7",
  },
  MATIC: {
    symbol: "MATIC",
    name: "Polygon",
    address: "0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676",
  },
  AAVE: {
    symbol: "AAVE",
    name: "Aave",
    address: "0x547a514d5e3769680Ce22B2361c10Ea13619e8a9",
  },
  UNI: {
    symbol: "UNI",
    name: "Uniswap",
    address: "0x553303d460EE0afB37EdFf9bE42922D8FF63220e",
  },
  COMP: {
    symbol: "COMP",
    name: "Compound",
    address: "0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5",
  },
  MKR: {
    symbol: "MKR",
    name: "Maker",
    address: "0xec1D1B3b0443256cc3860e24a46F108e699484Aa",
  },
  SNX: {
    symbol: "SNX",
    name: "Synthetix",
    address: "0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699",
  },
  CRV: {
    symbol: "CRV",
    name: "Curve DAO",
    address: "0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  },
  USDT: {
    symbol: "USDT",
    name: "Tether",
    address: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
  },
  DAI: {
    symbol: "DAI",
    name: "Dai",
    address: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
  },
};

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
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/[\/\-\s]*(usd|usdc|dollars?)$/, "")
    .trim();
  if (!cleaned) return null;
  const direct = CHAINLINK_FEEDS[cleaned.toUpperCase()];
  if (direct) return direct;
  const aliased = ALIASES[cleaned];
  return aliased ? CHAINLINK_FEEDS[aliased]! : null;
}

export const feedId = (symbol: string) => `feed:${symbol.toLowerCase()}-usd`;

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

const client = () =>
  createPublicClient({
    chain: mainnet,
    transport: http(MAINNET_RPC, { timeout: 12000 }),
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
export async function fetchFeedPrice(input: string): Promise<GraphObject> {
  const feed = resolveFeedSymbol(input);
  if (!feed)
    throw new Error(
      `No Chainlink mainnet feed configured for "${input}". Available: ${listFeedSymbols().join(", ")}`,
    );
  const rpc = client();
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
  return {
    id: feedId(feed.symbol),
    kind: "feed",
    label: `${feed.symbol} / USD`,
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
    },
    provenance: {
      source: "Chainlink Data Feed",
      url: `https://etherscan.io/address/${feed.address}#readContract`,
      observedAt,
      fetchedAt: new Date().toISOString(),
      chainId: 1,
      address: feed.address,
      kind: "chain",
      label: `Chainlink ${description} aggregator · Ethereum mainnet · round ${roundId} written ${describeAge(ageSeconds)}`,
    },
  };
}
