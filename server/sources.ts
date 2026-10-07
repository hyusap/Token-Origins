import { createPublicClient, http, formatEther, isAddress } from "viem";
import type { GraphObject } from "../shared/types";

const iso = () => new Date().toISOString();
const timeout = () => AbortSignal.timeout(8000);
export interface TokenMarket { symbol: string; name: string; productId: string }
// Exact matches only: never guess from fuzzy search or substitute another asset.
export function resolveToken(token: string, markets: TokenMarket[]): TokenMarket {
  const query = token.trim().toLowerCase();
  const qualified = query.startsWith("coinbase:");
  const key = qualified ? query.slice(9) : query;
  const matches = markets.filter((m) =>
    m.productId.toLowerCase() === key || m.symbol.toLowerCase() === key ||
    (!qualified && m.name.toLowerCase() === key));
  if (matches.length > 1)
    throw new Error(`Ambiguous token "${token}". Specify ${matches.map(m => `coinbase:${m.productId}`).join(" or ")}`);
  if (!matches.length)
    throw new Error(`Unsupported token "${token}": no exact Coinbase USD market. Use the full asset name, symbol, or coinbase:SYMBOL-USD; contract addresses are not supported.`);
  return matches[0]!;
}
let marketCache: { at: number; value: Promise<TokenMarket[]> } | undefined;
async function tokenMarkets(): Promise<TokenMarket[]> {
  if (marketCache && Date.now() - marketCache.at < 300_000) return marketCache.value;
  const value = (async () => {
    const responses = await Promise.all(["currencies", "products"].map(path =>
      fetch(`https://api.exchange.coinbase.com/${path}`, { signal: timeout() })));
    for (const response of responses) if (!response.ok)
      throw new Error(`Coinbase market catalog returned ${response.status}`);
    const [currencies, products] = await Promise.all(responses.map(r => r.json()));
    if (!Array.isArray(currencies) || !Array.isArray(products)) throw new Error("Invalid Coinbase market catalog");
    return products.filter(p => p.quote_currency === "USD" && p.status === "online" && !p.trading_disabled)
      .map(p => ({ symbol: p.base_currency, productId: p.id,
        name: currencies.find(c => c.id === p.base_currency)?.name || p.base_currency }));
  })();
  const entry = { at: Date.now(), value };
  marketCache = entry;
  try { return await value; } catch (error) { if (marketCache === entry) marketCache = undefined; throw error; }
}
export async function fetchPrice(token = "ETH"): Promise<GraphObject> {
  const isEth = ["eth", "ethereum", "eth-usd", "coinbase:eth-usd", "coinbase:eth"].includes(token.trim().toLowerCase());
  const market = isEth ? { symbol: "ETH", name: "Ethereum", productId: "ETH-USD" }
    : resolveToken(token, await tokenMarkets());
  const { symbol, name, productId } = market;

  let lastError: unknown;
  try {
    const url =
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/trades?limit=100`;
    const response = await fetch(url, {
      signal: timeout(),
      headers: { "User-Agent": "OriginsLedger/1.0" },
    });
    if (!response.ok) throw new Error(`Coinbase returned ${response.status}`);
    const trades = (await response.json()) as {
      price: string;
      time: string;
      trade_id: number;
    }[];
    const valid = trades.filter(
      (x) =>
        Number.isFinite(Number(x.price)) &&
        Number(x.price) > 0 &&
        Number.isFinite(Date.parse(x.time)),
    );
    if (!valid.length)
      throw new Error("Coinbase did not return valid timestamped trades");
    valid.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const trade = valid[0]!;
    return {
      id: `price:${productId.toLowerCase()}`,
      kind: "price",
      label: `${symbol} / USD`,
      visible: true,
      pinned: false,
      data: {
        price: Number(trade.price),
        unit: "USD",
        symbol,
        name,
        token: `coinbase:${productId}`,
        productId,
        tradeId: trade.trade_id,
        history: valid
          .reverse()
          .map((x) => ({ price: Number(x.price), observedAt: x.time })),
        historyLabel: "Actual exchange trades · latest 100 observations",
      },
      provenance: {
        source: "Coinbase Exchange",
        url,
        observedAt: trade.time,
        fetchedAt: iso(),
        kind: "live",
        label: "Live exchange trade · source timestamp",
      },
    };
  } catch (error) {
    lastError = error;
  }
  if (!isEth) throw new Error(`Price unavailable for ${name} (${symbol}): ${String(lastError)}`);
  try {
    const url = "https://api.kraken.com/0/public/Trades?pair=ETHUSD&count=100";
    const response = await fetch(url, { signal: timeout() });
    if (!response.ok) throw new Error(`Kraken returned ${response.status}`);
    const body = (await response.json()) as {
      error: string[];
      result: Record<string, any>;
    };
    if (body.error.length) throw new Error(body.error.join(", "));
    const rows = Object.entries(body.result).find(
      ([key]) => key !== "last",
    )?.[1] as any[][];
    const valid = rows
      .filter(
        (x) =>
          Number.isFinite(Number(x[0])) &&
          Number(x[0]) > 0 &&
          Number.isFinite(Number(x[2])),
      )
      .sort((a, b) => Number(a[2]) - Number(b[2]));
    const latest = valid.at(-1);
    if (!latest) throw new Error("Kraken did not return timestamped trades");
    return {
      id: "price:eth-usd",
      kind: "price",
      label: "ETH / USD",
      visible: true,
      pinned: false,
      data: {
        price: Number(latest[0]),
        unit: "USD",
        symbol: "ETH",
        name: "Ethereum",
        token: "coinbase:ETH-USD",
        productId: "ETH-USD",
        history: valid.map((x) => ({
          price: Number(x[0]),
          observedAt: new Date(Number(x[2]) * 1000).toISOString(),
        })),
        historyLabel: "Actual Kraken trades · latest observations",
      },
      provenance: {
        source: "Kraken",
        url,
        observedAt: new Date(Number(latest[2]) * 1000).toISOString(),
        fetchedAt: iso(),
        kind: "live",
        label: "Live exchange trade · source timestamp",
      },
    };
  } catch (error) {
    throw new Error(
      `Price sources unavailable: ${String(lastError)}; ${String(error)}`,
    );
  }
}
export interface Deployment {
  address: `0x${string}`;
  chainId: number;
  rpcUrl: string;
  [key: string]: any;
}
export async function loadDeployment(): Promise<Deployment | null> {
  if (process.env.ORIGINS_EXECUTION_MODE === "cre") {
    const address = process.env.ORIGINS_SEPOLIA_VAULT;
    if (!address || !isAddress(address))
      throw new Error(
        "CRE mode requires an explicitly configured Sepolia vault",
      );
    // The deploy record gives restart recovery a block to search logs from.
    const record = await Bun.file("contracts/deployment.sepolia.json").json().catch(() => null);
    return {
      address,
      chainId: 11155111,
      rpcUrl:
        process.env.ORIGINS_SEPOLIA_RPC ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      ...(record?.address?.toLowerCase() === address.toLowerCase() ? { blockNumber: record.blockNumber } : {}),
    };
  }
  const file = Bun.file(process.env.DEPLOYMENT_FILE || ".data/deployment.json");
  if (!(await file.exists())) return null;
  const raw = await file.json();
  const address = raw.address || raw.vaultAddress || raw.contractAddress;
  if (!isAddress(address) || !Number.isInteger(raw.chainId) || !raw.rpcUrl)
    throw new Error("Invalid vault deployment configuration");
  return { ...raw, address };
}
const vaultAbi = [
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
export async function fetchVault(fixturePaused = false): Promise<GraphObject> {
  const deployment = await loadDeployment();
  if (!deployment)
    return {
      id: "vault:grant",
      kind: "vault",
      label: "Grant vault",
      visible: true,
      pinned: false,
      data: {
        paused: fixturePaused,
        balance: "0.12",
        balanceEth: 0.12,
        chainId: null,
        address: null,
        fixture: true,
        network: "Local rehearsal fixture",
      },
      provenance: {
        source: "Local rehearsal fixture",
        observedAt: iso(),
        fetchedAt: iso(),
        kind: "fixture",
        label: "Fixture vault · no deployed contract",
      },
    };
  const client = createPublicClient({
    transport: http(deployment.rpcUrl, { timeout: 8000 }),
  });
  const blockNumber = await client.getBlockNumber();
  const [paused, balance, block, chainId] = await Promise.all([
    client.readContract({
      address: deployment.address,
      abi: vaultAbi,
      functionName: "paused",
      blockNumber,
    }),
    client.getBalance({ address: deployment.address, blockNumber }),
    client.getBlock({ blockNumber }),
    client.getChainId(),
  ]);
  if (chainId !== deployment.chainId)
    throw new Error("RPC chain does not match vault deployment");
  return {
    id: "vault:grant",
    kind: "vault",
    label: "Grant vault",
    visible: true,
    pinned: false,
    data: {
      paused,
      balance: formatEther(balance),
      balanceEth: Number(formatEther(balance)),
      address: deployment.address,
      chainId,
      blockNumber: String(blockNumber),
      fixture: false,
      network:
        chainId === 11155111
          ? "Ethereum Sepolia"
          : chainId === 31337
            ? "Local Anvil"
            : `Chain ${chainId}`,
    },
    provenance: {
      source: chainId === 31337 ? "Anvil contract read" : "EVM contract read",
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      fetchedAt: iso(),
      kind: "chain",
      chainId,
      address: deployment.address,
      label:
        chainId === 31337
          ? "Actual local contract · Anvil"
          : "Actual contract read",
    },
  };
}
