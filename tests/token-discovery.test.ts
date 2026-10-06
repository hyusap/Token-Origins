import { expect, test } from "bun:test";
import { fetchPrice, resolveToken } from "../server/sources";
import { command } from "../server/command";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { toolDefinitions } from "../server/schemas";
import type { GraphObject } from "../shared/types";

const markets = [
  { symbol: "ETH", name: "Ethereum", productId: "ETH-USD" },
  { symbol: "SOL", name: "Solana", productId: "SOL-USD" },
];
test("exact token identity, qualified IDs, ambiguous names, and unsupported assets", () => {
  expect(resolveToken("Solana", markets).symbol).toBe("SOL");
  expect(resolveToken("coinbase:SOL-USD", markets).symbol).toBe("SOL");
  expect(() => resolveToken("solan", markets)).toThrow("Unsupported");
  const ambiguous = [...markets, { symbol: "OTHER", name: "SOL", productId: "OTHER-USD" }];
  expect(() => resolveToken("SOL", ambiguous)).toThrow("Ambiguous");
  expect(resolveToken("coinbase:SOL-USD", ambiguous).symbol).toBe("SOL");
});
test("adapter resolves real catalog names and preserves timestamps and market provenance", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/currencies")) return Response.json(markets.map(m => ({ id: m.symbol, name: m.name })));
    if (url.endsWith("/products")) return Response.json(markets.map(m => ({ id: m.productId, base_currency: m.symbol, quote_currency: "USD", status: "online" })));
    if (url.includes("SOL-USD/trades")) return Response.json([{ price: "150.123", time: "2026-10-06T05:00:00Z", trade_id: 42 }]);
    if (url.includes("ETH-USD/trades")) return Response.json([{ price: "2500", time: "2026-10-06T05:00:01Z", trade_id: 43 }]);
    throw new Error(`Unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  try {
    const sol = await fetchPrice("Solana");
    const eth = await fetchPrice();
    expect(sol.id).toBe("price:sol-usd");
    expect(sol.data.name).toBe("Solana");
    expect(sol.data.price).toBe(150.123);
    expect(sol.data.token).toBe("coinbase:SOL-USD");
    expect(sol.provenance.observedAt).toBe("2026-10-06T05:00:00Z");
    expect(sol.provenance.url).toContain("SOL-USD/trades");
    expect(eth.id).toBe("price:eth-usd");
    await expect(fetchPrice("not-a-token")).rejects.toThrow("Unsupported");
    expect(calls.filter(x => x.includes("ETH-USD/trades"))).toHaveLength(1);
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchPrice("SOL")).rejects.toThrow("Price unavailable for Solana");
  } finally { globalThis.fetch = original; }
});
const price = (token = "ETH"): GraphObject => {
  const m = resolveToken(token, markets);
  return { id: `price:${m.productId.toLowerCase()}`, kind: "price", label: `${m.symbol} / USD`,
    visible: true, pinned: false, data: { symbol: m.symbol, name: m.name, token: `coinbase:${m.productId}`, price: m.symbol === "ETH" ? 2500 : 150 },
    provenance: { source: "Test", kind: "fixture", label: "Test", fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString() } };
};
function engine() {
  const calls: string[] = [];
  const e = new Engine(new StateStore(":memory:"), {
    fetchPrice: async (token = "ETH") => { calls.push(token); return price(token); },
    fetchVault: async () => ({ ...price(), id: "vault:grant", kind: "vault", label: "Grant vault", data: { fixture: true, paused: false, balance: "0.12" } }),
    loadDeployment: async () => null,
  });
  return { e, calls };
}
test("multiple token objects persist, generic price clarifies, SOL refresh and source stay SOL", async () => {
  const { e, calls } = engine();
  const args = toolDefinitions.discover_objects.schema.parse({ objects: ["price"], tokens: ["ETH", "Solana"], operationId: "d" });
  expect((await e.invoke("discover_objects", args)).ok).toBe(true);
  expect(e.state.objects.filter(x => x.kind === "price")).toHaveLength(2);
  expect(e.resolve("price")).toBeNull();
  expect(e.state.clarification?.candidates).toHaveLength(2);
  expect(e.resolve("Solana")?.id).toBe("price:sol-usd");
  await e.invoke("inspect_object", { reference: "SOL", refresh: true, operationId: "refresh" });
  expect(calls.at(-1)).toBe("coinbase:SOL-USD");
  expect(e.state.focus.objectId).toBe("price:sol-usd");
  expect(e.resolve("source")?.data.priceObjectId).toBe("price:sol-usd");
});
test("partial discovery discloses failure; SOL cannot stand in for the ETH policy", async () => {
  const { e } = engine();
  const result = await e.invoke("discover_objects", { tokens: ["SOL", "unknown"], operationId: "d" });
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("partly succeeded");
  expect(e.state.objects.some(x => x.id === "price:eth-usd")).toBe(false);
  const policy = await e.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 200 }, operationId: "p" });
  expect(policy.ok).toBe(false);
  expect(policy.error).toContain("ETH/USD");
});

test("keyboard fallback discovers named tokens instead of silently defaulting to ETH", async () => {
  const { e } = engine();
  expect((await command(e, "Show me Solana’s price", "k1")).ok).toBe(true);
  expect(e.state.objects.some(x => x.id === "price:sol-usd")).toBe(true);
  expect(e.state.objects.some(x => x.id === "price:eth-usd")).toBe(false);
  expect((await command(e, "Show prices for ETH and SOL and our grant vault", "k2")).ok).toBe(true);
  expect(e.state.objects.filter(x => x.kind === "price")).toHaveLength(2);
  expect(e.state.objects.some(x => x.kind === "vault")).toBe(true);
});
