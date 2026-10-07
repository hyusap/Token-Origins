// Representative full canvas states for UI/voice work, produced by the real engine.
//   bun run scripts/generate-fixtures.ts   → fixtures/states/*.json
// Inputs are fixed test prices and a fixture or mocked deployed vault; every
// decision, guard, caption and evidence field comes from the actual code paths.
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { describeGraph, FEED_REGISTRY, policyGraphSchema, type PolicyGraph } from "../cre/graph";
import type { ExecutionEvidence } from "../cre/runner";
import type { CanvasState, GraphObject } from "../shared/types";

const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const eth = (usd: number): GraphObject => ({
  id: "price:eth-usd", kind: "price", label: "ETH / USD", data: { price: usd, unit: "USD", symbol: "ETH", name: "Ethereum", token: "coinbase:ETH-USD", history: [] },
  provenance: { source: "Coinbase Exchange", url: "https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=100", kind: "live", label: "Fixture input shaped like a live Coinbase trade", observedAt: iso(4), fetchedAt: iso() },
  visible: true, pinned: false,
});
const vault = (paused: boolean): GraphObject => ({
  id: "vault:grant", kind: "vault", label: "Grant vault", data: { paused, balance: "1.2049", balanceEth: 1.2049, fixture: true, network: "Local rehearsal fixture" },
  provenance: { source: "Local rehearsal fixture", kind: "fixture", label: "Fixture vault · no deployed contract", observedAt: iso(), fetchedAt: iso() },
  visible: true, pinned: false,
});
const feed = (symbol: "BTC" | "ETH", usd: number): GraphObject => {
  const address = FEED_REGISTRY["ethereum-mainnet"][symbol]!;
  return {
    id: `feed:${symbol.toLowerCase()}-usd`, kind: "feed", label: `${symbol} / USD`,
    data: { price: usd, unit: "USD", symbol, decimals: 8, answer: String(usd * 1e8), roundId: "110680464442257320164", ageSeconds: 1500, ageLabel: "25 min ago", feedAddress: address, description: `${symbol} / USD`, network: "ethereum-mainnet" },
    provenance: { source: "Chainlink Data Feed", url: `https://etherscan.io/address/${address}#readContract`, kind: "chain", chainId: 1, address, label: `Chainlink ${symbol} / USD aggregator · Ethereum mainnet`, observedAt: iso(1500), fetchedAt: iso() },
    visible: true, pinned: false,
  };
};
const DEPLOYED = { address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const, chainId: 31337, rpcUrl: "http://127.0.0.1:8545" };

interface Setup { ethUsd?: number; btcUsd?: number; paused?: boolean; deployed?: (spec: any) => Promise<ExecutionEvidence> }
function engine(setup: Setup) {
  return new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => eth(setup.ethUsd ?? 2500),
    fetchVault: async (fixturePaused = false) => vault(Boolean(setup.paused) || fixturePaused),
    fetchFeedPrice: async (symbol: string) => feed(symbol as "BTC", setup.btcUsd ?? 85000),
    loadDeployment: async () => (setup.deployed ? DEPLOYED : null),
    ...(setup.deployed ? { executeRun: setup.deployed as any } : {}),
  });
}
async function settle(e: Engine) {
  for (let i = 0; i < 400; i++) {
    if (e.state.runs.every((r) => ["confirmed", "no-op", "failed"].includes(r.status))) return;
    await Bun.sleep(5);
  }
  throw new Error("run did not settle");
}
const N = {
  eth: { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
  btc: { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC", network: "ethereum-mainnet" } },
};
const nested = {
  nodes: [
    N.eth, N.btc,
    { id: "ethUnder", kind: "compare", input: "eth", op: "<", value: 3000 },
    { id: "btcUnder", kind: "compare", input: "btc", op: "<", value: 80000 },
    { id: "vaultPaused", kind: "vault-paused", equals: true },
    { id: "notPaused", kind: "not", input: "vaultPaused" },
    { id: "btcOrActive", kind: "or", inputs: ["btcUnder", "notPaused"] },
    { id: "root", kind: "and", inputs: ["ethUnder", "btcOrActive"] },
  ],
  root: "root", action: { type: "pause-vault" },
};
const both = {
  nodes: [N.eth, N.btc, { id: "ethUnder", kind: "compare", input: "eth", op: "<", value: 3000 }, { id: "btcUnder", kind: "compare", input: "btc", op: "<", value: 80000 }, { id: "both", kind: "and", inputs: ["ethUnder", "btcUnder"] }],
  root: "both", action: { type: "pause-vault" },
};
const verified = async (spec: any): Promise<ExecutionEvidence> => ({
  runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash, mode: "local-evm-rehearsal",
  observations: [
    { key: "exchange-trade:ETH-USD", provider: "coinbase", label: "Coinbase ETH-USD trade", url: "https://api.exchange.coinbase.com/products/ETH-USD/ticker", usd: 2500, raw: "2500.00", observedAt: iso(3), fetchedAt: iso(1) },
    { key: "chainlink-feed:ethereum-mainnet:BTC", provider: "chainlink", label: "Chainlink BTC/USD (mainnet)", network: "ethereum-mainnet", chainId: 1, address: FEED_REGISTRY["ethereum-mainnet"].BTC!, decimals: 8, usd: 78000, raw: "7800000000000", roundId: "110680464442257320164", observedAt: iso(1500), fetchedAt: iso(1) },
  ],
  vault: { address: DEPLOYED.address, chainId: 31337, paused: false, balanceWei: "1204900000000000000", reportVersion: 2 },
  conditions: [
    { nodeId: "ethUnder", kind: "threshold", role: "node", passed: true, detail: "Coinbase ETH-USD trade $2,500.00 < $3,000.00" },
    { nodeId: "btcUnder", kind: "threshold", role: "node", passed: true, detail: "Chainlink BTC/USD (mainnet) $78,000.00 < $80,000.00" },
    { nodeId: "both", kind: "and", role: "node", passed: true, detail: "ethUnder AND btcUnder → true" },
    { nodeId: "guard:root", kind: "composed-policy", role: "root", passed: true, detail: 'Policy root "both" evaluated true' },
    { nodeId: "guard:source:exchange-trade:ETH-USD", kind: "source-freshness", role: "guard", passed: true, detail: "Coinbase ETH-USD trade observed 3.0s ago; limit 60s" },
    { nodeId: "guard:source:chainlink-feed:ethereum-mainnet:BTC", kind: "source-freshness", role: "guard", passed: true, detail: "Chainlink BTC/USD (mainnet) observed 1500.0s ago; limit 93600s" },
    { nodeId: "guard:vault-active", kind: "vault-state", role: "guard", passed: true, detail: "Vault spending active" },
  ],
  root: true, decision: "act", action: "pause-vault", decidedAt: iso(1), logs: [],
  transaction: { hash: "0x7c3e0b6f1d8a4e2b9c5f3a1e7d6b4c2a9e8f7d6c5b4a39281706f5e4d3c2b1a0", blockNumber: 12, status: "success", receiverConfirmed: true, pausedAfter: true },
});

interface Fixture { name: string; description: string; build: () => Promise<{ e: Engine; error?: string }>; utterance: string }
export const FIXTURES: Fixture[] = [
  { name: "legacy-rule", utterance: "If ETH drops below three thousand dollars, pause spending from the grant vault.", description: "Single-threshold rule composed with a scalar edit. The graph is the two-node legacy shape.",
    build: async () => { const e = engine({}); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 3000, maxAgeSeconds: 60 }, operationId: "p" }); return { e }; } },
  { name: "nested-and-or-not", utterance: "Pause if ETH is under three thousand and either bitcoin is under eighty thousand or the vault isn't already paused.", description: "A AND (B OR NOT C), not yet run. Canvas must show the nesting.",
    build: async () => { const e = engine({}); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: nested, operationId: "c" }); return { e }; } },
  { name: "false-root-true-branch", utterance: "Run this version.", description: "ETH branch true, BTC branch false (BTC $85k ≥ $80k), so the AND root is false: no action. A true intermediate is not success.",
    build: async () => { const e = engine({ btcUsd: 85000 }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: both, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
  { name: "true-branch-in-passing-or", utterance: "Run this version.", description: "BTC branch false but NOT(paused) true, so the OR and the root pass and the fixture vault pauses. A false intermediate is not failure.",
    build: async () => { const e = engine({ btcUsd: 85000 }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: nested, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
  { name: "guard-blocked-true-root", utterance: "Run it again.", description: "Policy root is true but the vault is already paused: the mandatory guard stops a second pause.",
    build: async () => { const e = engine({ btcUsd: 78000, paused: true }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: both, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
  { name: "unsupported-source", utterance: "Use the Solana price on Sepolia instead.", description: "SOL has no Sepolia feed: the edit is refused, the draft stays at its previous revision, and the error is visible.",
    build: async () => { const e = engine({}); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: both, operationId: "c" });
      const r = await e.invoke("compose_graph", { expectedRevision: 1, graph: { nodes: [{ id: "sol", kind: "price", source: { type: "chainlink-feed", symbol: "SOL", network: "ethereum-sepolia" } }, { id: "solUnder", kind: "compare", input: "sol", op: "<", value: 100 }], root: "solUnder", action: { type: "pause-vault" } }, operationId: "bad" });
      return { e, error: r.error }; } },
  { name: "mock-sell", utterance: "If bitcoin drops under ninety thousand, sell half a bitcoin.", description: "Simulated sell: evidence names the reference price and says no transaction and no asset moved. No pause, no block.",
    build: async () => { const e = engine({ btcUsd: 85000 }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: { nodes: [N.btc, { id: "drop", kind: "compare", input: "btc", op: "<", value: 90000 }], root: "drop", action: { type: "sell", symbol: "BTC", amount: 0.5, venue: "mock-venue" } }, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
  { name: "failed-write", utterance: "Run this version.", description: "Deployed vault, decision to act, but the receipt/event/read did not all verify: the run is failed with no success evidence.",
    build: async () => { const e = engine({ deployed: async () => { throw new Error("Transaction, receiver event, and fresh pause read did not all confirm"); } }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: both, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
  { name: "verified-pause", utterance: "Run this version.", description: "Deployed local vault: receipt + SpendingPaused(run, revision, policy hash) + fresh paused() read, with every input archived.",
    build: async () => { const e = engine({ deployed: verified }); await e.invoke("discover_objects", { operationId: "d" }); await e.invoke("compose_graph", { expectedRevision: 0, graph: both, operationId: "c" }); await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" }); await settle(e); return { e }; } },
];

/** Graph structure as the canvas must render it: every node with its inputs. */
function structure(graph: PolicyGraph) {
  return {
    root: graph.root,
    action: graph.action,
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, inputs: "inputs" in n ? n.inputs : "input" in n ? [n.input] : [] })),
  };
}
export async function buildFixtures() {
  const out: { name: string; description: string; expected: Record<string, unknown>; state: CanvasState }[] = [];
  for (const fixture of FIXTURES) {
    const { e, error } = await fixture.build();
    const state = e.context();
    const run = state.runs[0];
    const graph = policyGraphSchema.parse(state.workflow.graph);
    out.push({
      name: fixture.name,
      description: fixture.description,
      expected: {
        utterance: fixture.utterance,
        policySentence: describeGraph(graph),
        policyHash: state.workflow.policyHash,
        structure: structure(graph),
        ...(run ? { runStatus: run.status, runCaption: state.activity.summary, noopReason: run.noopReason ?? null, blockedBy: run.decisions.find((d) => d.role !== "node" && !d.passed)?.nodeId ?? null } : {}),
        ...(error ? { error } : {}),
      },
      state,
    });
  }
  return out;
}

if (import.meta.main) {
  for (const fixture of await buildFixtures()) {
    await Bun.write(`fixtures/states/${fixture.name}.json`, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`fixtures/states/${fixture.name}.json · ${fixture.expected.runStatus ?? "draft"} · ${fixture.expected.policySentence}`);
  }
}
