import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import {
  resolveFeedSymbol,
  listFeedSymbols,
  describeAge,
  feedId,
  CHAINLINK_FEEDS,
} from "../server/chainlink";
import { FEED_SYMBOLS } from "../cre/graph";
import type { GraphObject } from "../shared/types";

const price = (): GraphObject => ({
  id: "price:eth-usd",
  kind: "price",
  label: "ETH / USD",
  data: { price: 2500, history: [] },
  provenance: {
    source: "Test adapter",
    kind: "fixture",
    label: "Test input",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const vault = (paused = false): GraphObject => ({
  id: "vault:grant",
  kind: "vault",
  label: "Grant vault",
  data: { paused, balance: "0.12", fixture: true },
  provenance: {
    source: "Fixture",
    kind: "fixture",
    label: "Test fixture",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const feed = (symbol: string, value: number, ageSeconds: number): GraphObject => {
  const definition = CHAINLINK_FEEDS[symbol]!;
  const observedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    id: feedId(symbol),
    kind: "feed",
    label: `${symbol} / USD`,
    data: {
      price: value,
      symbol,
      name: definition.name,
      ageSeconds,
      ageLabel: describeAge(ageSeconds),
      roundId: "129127208515966886205",
      feedAddress: definition.address,
      description: `${symbol} / USD`,
    },
    provenance: {
      source: "Chainlink Data Feed",
      kind: "chain",
      chainId: 1,
      address: definition.address,
      label: `Chainlink ${symbol} / USD aggregator`,
      observedAt,
      fetchedAt: new Date().toISOString(),
    },
    visible: true,
    pinned: false,
  };
};
const create = (overrides: any = {}) =>
  new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => price(),
    fetchVault: async (paused = false) => vault(paused),
    loadDeployment: async () => null,
    fetchFeedPrice: async (input: string) => feed(input, 85000, 2400),
    ...overrides,
  });

test("spoken and written asset forms resolve to one configured feed", () => {
  for (const form of ["BTC", "btc", "Bitcoin", " bitcoin ", "$BTC", "BTC/USD", "btc-usd"])
    expect(resolveFeedSymbol(form)?.symbol).toBe("BTC");
  expect(resolveFeedSymbol("chainlink")?.symbol).toBe("LINK");
  expect(resolveFeedSymbol("polygon")?.symbol).toBe("MATIC");
  expect(resolveFeedSymbol("dogecoin")).toBeNull();
  expect(resolveFeedSymbol("")).toBeNull();
});

test("every configured feed address is a distinct mainnet address", () => {
  const addresses = listFeedSymbols().map((s) => CHAINLINK_FEEDS[s]!.address.toLowerCase());
  expect(new Set(addresses).size).toBe(addresses.length);
  for (const address of addresses) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
});

test("feed age is described in units that keep staleness legible", () => {
  expect(describeAge(42)).toBe("42s ago");
  expect(describeAge(2400)).toBe("40 min ago");
  expect(describeAge(53640)).toBe("14.9 h ago");
  expect(describeAge(259200)).toBe("3.0 days ago");
});

test("reading a feed adds a focused object and reports the aggregator's own age", async () => {
  const engine = create();
  const result = await engine.invoke("read_price_feed", {
    symbol: "bitcoin",
    operationId: "read-btc",
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("Bitcoin");
  expect(result.summary).toContain("40 min ago");
  // The caption must never let a heartbeat-delayed answer pass as spot price.
  expect(result.summary).toContain("not the vault's execution price");
  const object = engine.state.objects.find((o) => o.id === "feed:btc-usd")!;
  expect(object.kind).toBe("feed");
  expect(object.provenance.chainId).toBe(1);
  expect(engine.state.focus.objectId).toBe("feed:btc-usd");
});

test("an unconfigured asset fails visibly and lists what is available", async () => {
  const engine = create();
  const result = await engine.invoke("read_price_feed", {
    symbol: "dogecoin",
    operationId: "read-doge",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("dogecoin");
  expect(result.error).toContain("BTC");
  expect(engine.state.objects.filter((o) => o.kind === "feed")).toHaveLength(0);
});

test("feed reads never displace the Coinbase object the execution path depends on", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: "discover" });
  await engine.invoke("read_price_feed", { symbol: "ETH", operationId: "read-eth" });
  const execution = engine.state.objects.find((o) => o.id === "price:eth-usd")!;
  expect(execution.kind).toBe("price");
  expect(execution.data.price).toBe(2500);
  expect(execution.provenance.source).toBe("Test adapter");
  // "eth" is an established alias for the execution input; a mainnet feed object
  // of the same asset must not capture that reference.
  expect(engine.resolve("eth")!.id).toBe("price:eth-usd");
  expect(engine.resolve("price")!.id).toBe("price:eth-usd");
  // An asset with no execution-path twin still resolves by ticker and by name.
  await engine.invoke("read_price_feed", { symbol: "SOL", operationId: "read-sol" });
  expect(engine.resolve("sol")!.id).toBe("feed:sol-usd");
  expect(engine.resolve("solana")!.id).toBe("feed:sol-usd");
});

test("refreshing a feed re-reads that same asset's aggregator", async () => {
  const seen: string[] = [];
  const engine = create({
    fetchFeedPrice: async (input: string) => {
      seen.push(input);
      return feed(resolveFeedSymbol(input)!.symbol, 91000, 120);
    },
  });
  await engine.invoke("read_price_feed", { symbol: "BTC", operationId: "read-btc" });
  const result = await engine.invoke("inspect_object", {
    reference: "bitcoin",
    refresh: true,
    operationId: "inspect-btc",
  });
  expect(result.ok).toBe(true);
  expect(seen).toEqual(["BTC", "BTC"]);
  expect(result.summary).toContain("91000");
  expect(result.summary).toContain("0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c");
});

test("listing feeds names every configured asset", async () => {
  const result = await create().invoke("list_price_feeds", {});
  expect(result.ok).toBe(true);
  for (const symbol of listFeedSymbols()) expect(result.summary).toContain(symbol);
});

test("the graph's feed allowlist matches the address registry exactly", () => {
  // cre/graph.ts carries only symbol names so the WASM bundle never pulls an
  // RPC client in; drift between the two lists would let a graph name a feed
  // the backend cannot resolve.
  expect([...FEED_SYMBOLS].sort() as string[]).toEqual(listFeedSymbols().sort());
  for (const symbol of FEED_SYMBOLS) expect(CHAINLINK_FEEDS[symbol]).toBeDefined();
});
