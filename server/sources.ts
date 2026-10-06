import { createPublicClient, http, formatEther, isAddress } from "viem";
import type { GraphObject } from "../shared/types";

const iso = () => new Date().toISOString();
const timeout = () => AbortSignal.timeout(8000);
export async function fetchPrice(): Promise<GraphObject> {
  let lastError: unknown;
  try {
    const url =
      "https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=100";
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
      id: "price:eth-usd",
      kind: "price",
      label: "ETH / USD",
      visible: true,
      pinned: false,
      data: {
        price: Number(trade.price),
        unit: "USD",
        symbol: "ETH",
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
    return {
      address,
      chainId: 11155111,
      rpcUrl:
        process.env.ORIGINS_SEPOLIA_RPC ||
        "https://ethereum-sepolia-rpc.publicnode.com",
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
