import { createPublicClient, http, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import type { GraphObject } from "../shared/types";
import { readChainSource } from "../cre/onchain-reads";
import {
  sourceIdentity,
  sourceKey,
  describeSource,
  unitOfSource,
  formatValue,
  NETWORKS,
  POR_REGISTRY,
  TOKEN_REGISTRY,
  LENDING_REGISTRY,
  MAX_FEED_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  type ChainSource,
  type FeedSource,
  type Network,
  type Observation,
  type Source,
} from "../cre/graph";
import { MAINNET_RPC, SEPOLIA_RPC, describeAge, feedObjectId } from "./chainlink";

/**
 * Contract-backed readings beyond price feeds: Chainlink Proof of Reserve,
 * ERC-20 supply, and Aave/Compound supply rates. The backend reads them with
 * the same call plan and decoding the CRE workflow uses (cre/onchain-reads.ts),
 * so the canvas shows exactly the number execution will see.
 */
export type ReadingSource = Exclude<ChainSource, FeedSource>;

const clients = new Map<Network, ReturnType<typeof createPublicClient>>();
const client = (network: Network) => {
  let found = clients.get(network);
  if (!found) {
    found = createPublicClient({
      chain: network === "ethereum-sepolia" ? sepolia : mainnet,
      transport: http(network === "ethereum-sepolia" ? SEPOLIA_RPC : MAINNET_RPC, { timeout: 12000 }),
    });
    clients.set(network, found);
  }
  return found;
};

/** Canvas object that displays a source's reading. */
export function readingObjectId(source: Source): string {
  switch (source.type) {
    case "exchange-trade": return "price:eth-usd";
    case "chainlink-feed": return feedObjectId(source);
    case "vault-balance": return "vault:grant";
    default: return `reading:${sourceKey(source)}`;
  }
}

/** Reads one registry source through RPC and returns its canvas card. */
export async function fetchReading(source: ReadingSource): Promise<GraphObject> {
  const identity = sourceIdentity(source);
  const network = identity.network!;
  const reading = await readChainSource(source, async (call) =>
    (await client(call.network).call({ to: call.to, data: call.data })).data as Hex ?? "0x");
  const fetchedAt = new Date().toISOString();
  const observedAt = reading.updatedAt ? new Date(reading.updatedAt * 1000).toISOString() : fetchedAt;
  const ageSeconds = (Date.now() - Date.parse(observedAt)) / 1000;
  const unit = unitOfSource(source);
  const net = NETWORKS[network];
  return {
    id: readingObjectId(source),
    kind: "reading",
    label: describeSource(source),
    visible: true,
    pinned: false,
    data: {
      value: reading.value,
      unit: identity.unit,
      display: formatValue(reading.value, unit),
      raw: reading.raw,
      ...(reading.roundId ? { roundId: reading.roundId } : {}),
      sourceKey: identity.key,
      source,
      network,
      chainId: net.chainId,
      address: identity.address,
      ...(identity.asset ? { asset: identity.asset } : {}),
      ageSeconds: Math.round(ageSeconds),
      ageLabel: reading.updatedAt ? describeAge(ageSeconds) : "read just now",
      maxAgeSeconds: reading.updatedAt ? MAX_FEED_AGE_SECONDS : MAX_STATE_AGE_SECONDS,
    },
    provenance: {
      source: identity.provider === "chainlink" ? "Chainlink Proof of Reserve" : identity.provider === "erc20" ? "ERC-20 contract" : `${identity.provider === "aave" ? "Aave v3" : "Compound v3"} contract`,
      url: `${net.explorer}/address/${identity.address}#readContract`,
      observedAt,
      fetchedAt,
      chainId: net.chainId,
      address: identity.address,
      kind: "chain",
      label: reading.updatedAt
        ? `${describeSource(source)} · ${net.label} · round ${reading.roundId} written ${describeAge(ageSeconds)}`
        : `${describeSource(source)} · ${net.label} · contract state read now`,
    },
  };
}

/** Archive form of a reading, bound to the registry identity the policy hash uses. */
export function readingObservation(object: GraphObject, source: ReadingSource): Observation {
  const identity = sourceIdentity(source);
  const address = String(object.data.address || object.provenance.address || "");
  if (object.kind !== "reading" || object.data.sourceKey !== identity.key || address.toLowerCase() !== identity.address!.toLowerCase())
    throw new Error(`Reading for ${identity.label} came from ${address || "an unknown contract"}, not ${identity.address}`);
  return {
    ...identity,
    value: Number(object.data.value),
    raw: String(object.data.raw),
    ...(object.data.roundId ? { roundId: String(object.data.roundId) } : {}),
    observedAt: object.provenance.observedAt,
    fetchedAt: object.provenance.fetchedAt,
  };
}

/** Every reading a policy can name, for the agent's catalog. */
export function readingCatalog(): string[] {
  return [
    ...Object.entries(POR_REGISTRY).map(([asset, entry]) => `Proof of Reserve ${asset} (${entry.backs}; {"type":"proof-of-reserve","asset":"${asset}"})`),
    ...Object.keys(TOKEN_REGISTRY).map((token) => `${token} total supply ({"type":"token-supply","token":"${token}"})`),
    ...Object.entries(LENDING_REGISTRY).flatMap(([protocol, entry]) => Object.keys(entry.assets).map((asset) => `${entry.label} ${asset} supply APR ({"type":"lending-rate","protocol":"${protocol}","asset":"${asset}"})`)),
    'Vault ETH balance ({"type":"vault-balance"})',
  ];
}
