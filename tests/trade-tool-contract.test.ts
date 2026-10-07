import { Database } from "bun:sqlite";
import { createTradeTools } from "../server/trade-tools";
import type { EvmTradeUtilities } from "../server/evm-trades";
import type { TradeWatchAdapter } from "../server/evm-trade-watch";
import { expect, test } from "bun:test";
import { toolDefinitions, publicToolDefinitions, CRE_UNAVAILABLE_PRODUCT_TOOLS } from "../server/schemas";
import { supportedPolicyCapabilities } from "../shared/policy-capabilities";
import { VERSIONED_TOOLS } from "../scripts/mcp-forward";

const source = { network: "local", venueId: "verified-pair", wallet: "0x" + "1".repeat(40), transactionHash: "0x" + "2".repeat(64) };
const copy = { ...source, proportionBps: 1300, maxAmountIn: "1000000", minAmountOut: "990000", operationId: "copy:bounded-1" };

test("copy tools retain exact immutable source and raw-token bounds while mainnet stays read-only", () => {
  expect(toolDefinitions.inspect_evm_swap.schema.parse({ ...source, network: "ethereum" }).network).toBe("ethereum");
  expect(toolDefinitions.copy_evm_swap.schema.parse(copy)).toMatchObject(copy);
  expect(toolDefinitions.copy_evm_swap.schema.safeParse({ ...copy, network: "ethereum" }).success).toBe(false);
  for (const amount of ["0", "01", "1.01", "1e18", (2n ** 256n).toString()])
    expect(toolDefinitions.copy_evm_swap.schema.safeParse({ ...copy, maxAmountIn: amount }).success).toBe(false);
  for (const extra of [{ privateKey: "not-user-signing" }, { rpcUrl: "https://untrusted.example" }, { router: source.wallet }])
    expect(toolDefinitions.copy_evm_swap.schema.safeParse({ ...copy, ...extra }).success).toBe(false);
  expect(toolDefinitions.reconcile_evm_copy_swap.schema.parse({ copyOperationId: copy.operationId })).toEqual({ copyOperationId: copy.operationId });
});

test("trade-watch authority needs one explicit token direction and bounded budgets", () => {
  const watch = { network: "local", venueId: source.venueId, leader: source.wallet,
    tokenIn: "0x" + "3".repeat(40), tokenOut: "0x" + "4".repeat(40),
    proportionBps: 1300, perTradeInputCapRaw: "1000000", cumulativeInputCapRaw: "3000000",
    slippageBps: 100, maxTrades: 3, operationId: "watch:bounded-1" };
  expect(toolDefinitions.activate_evm_trade_watch.schema.parse(watch)).toMatchObject({ ...watch, startBlock: "next", intervalSeconds: 30 });
  const { tokenIn, ...withoutDirection } = watch;
  expect(toolDefinitions.activate_evm_trade_watch.schema.safeParse(withoutDirection).success).toBe(false);
  for (const invalid of [{ slippageBps: 501 }, { maxTrades: 101 }, { intervalSeconds: 14 }, { network: "ethereum" }])
    expect(toolDefinitions.activate_evm_trade_watch.schema.safeParse({ ...watch, ...invalid }).success).toBe(false);
  const predicate = { graph: { nodes: [{ id: "sol", kind: "price", source: { type: "exchange-trade", pair: "SOL-USD" } },
    { id: "below", kind: "compare", input: "sol", op: "<", value: 100 }], root: "below" }, exchangeMaxAgeSeconds: 60 };
  expect(toolDefinitions.activate_evm_trade_watch.schema.parse({ ...watch, predicate }).predicate?.graph.root).toBe("below");
  expect(toolDefinitions.activate_evm_trade_watch.schema.safeParse({ ...watch, predicate: { ...predicate, graph: { ...predicate.graph, root: "missing" } } }).success).toBe(false);
});

test("every actionable EVM trade tool refuses obsolete runtime semantics", () => {
  for (const name of Object.keys(toolDefinitions).filter(name => name.includes("evm_")))
    expect(VERSIONED_TOOLS.has(name)).toBe(true);
});

test("CRE product exposes only receiver-backed pause actions and hides standalone signer experiments", () => {
  for (const name of CRE_UNAVAILABLE_PRODUCT_TOOLS) expect(publicToolDefinitions).not.toHaveProperty(name);
  const nodes = [{id:"sol",kind:"price",source:{type:"exchange-trade",pair:"SOL-USD"}},{id:"below",kind:"compare",input:"sol",op:"<",value:100}];
  const base = {expectedRevision:0,operationId:"compose:cre",graph:{nodes,root:"below",action:{type:"pause-vault"}}};
  expect(toolDefinitions.compose_graph.schema.safeParse(base).success).toBe(true);
  expect(toolDefinitions.compose_graph.schema.safeParse({...base,graph:{...base.graph,action:{type:"solana-transfer",network:"devnet",recipient:"1".repeat(32),amountLamports:1}}}).success).toBe(false);
});

test("internal signer facade rejects writes before touching a signer or watch adapter", async () => {
  const db = new Database(":memory:");
  let signingCalls = 0;
  const utilities = {copySwap:async()=>{signingCalls++;throw new Error("must not sign");},close:()=>{}} as unknown as EvmTradeUtilities;
  const adapter = {freeze:async()=>{signingCalls++;throw new Error("must not activate");}} as unknown as TradeWatchAdapter;
  const facade = createTradeTools({db,utilities,watchAdapter:adapter,scheduling:true});
  try {
    for (const name of ["copy_evm_swap","activate_evm_trade_watch"])
      await expect(facade.invoke(name,{},"session")).rejects.toThrow("CRE_EXECUTION_REQUIRED");
    expect(signingCalls).toBe(0);
    expect(facade.listWatches()).toHaveLength(0);
  } finally {facade.close();db.close();}
});

test("optional freshness limit is distinct from the mandatory 26-hour oracle guard", () => {
  expect(supportedPolicyCapabilities.limits.freshnessNodeMaxAgeSeconds).toBe(86400);
  expect(supportedPolicyCapabilities.limits.feedMaxAgeSeconds).toBe(93600);
  const graph = {nodes:[
    {id:"eth",kind:"price",source:{type:"chainlink-feed",network:"ethereum-mainnet",symbol:"ETH"}},
    {id:"fresh",kind:"freshness",input:"eth",maxAgeSeconds:86400},
  ],root:"fresh",action:{type:"pause-vault"}};
  const args={expectedRevision:0,operationId:"freshness:bounded",graph};
  expect(toolDefinitions.compose_graph.schema.safeParse(args).success).toBe(true);
  expect(toolDefinitions.compose_graph.schema.safeParse({...args,graph:{...graph,nodes:[graph.nodes[0],{...graph.nodes[1],maxAgeSeconds:93600}]}}).success).toBe(false);
});
