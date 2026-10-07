import { test, expect } from "bun:test";
import { isLegacyPolicy } from "../src/policy-shape";
import { isLegacyShape, legacyGraph, reportedThreshold } from "../cre/graph";
import type { PolicyGraph } from "../shared/types";

const composed = (nodes: number): PolicyGraph => ({
  nodes: [
    { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
    { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
    { id: "a", kind: "compare", input: "eth", op: "<", value: 3000 },
    { id: "b", kind: "compare", input: "btc", op: "<", value: 90000 },
    { id: "both", kind: "and", inputs: ["a", "b"] },
  ].slice(0, nodes) as PolicyGraph["nodes"],
  root: "both",
  action: { type: "pause-vault" },
});

test("a five-node composed policy is not classified as legacy", () => {
  const graph = composed(5);
  expect(graph.nodes).toHaveLength(5);
  // The regression: this returned true, so composed policies rendered with the
  // scalar threshold panel and the composed view was never shown.
  expect(isLegacyPolicy(graph)).toBe(false);
  expect(isLegacyShape(graph)).toBe(false);
});

test("the browser mirror agrees with cre/graph.ts on every shape", () => {
  const cases: PolicyGraph[] = [
    legacyGraph(3000),
    composed(5),
    composed(2),
    { ...legacyGraph(3000), root: "eth" },
    {
      nodes: [
        { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
        { id: "a", kind: "compare", input: "btc", op: "<", value: 90000 },
      ],
      root: "a",
      action: { type: "pause-vault" },
    },
    {
      nodes: [
        { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
        { id: "a", kind: "compare", input: "eth", op: ">", value: 3000 },
      ],
      root: "a",
      action: { type: "pause-vault" },
    },
  ];
  for (const graph of cases)
    expect([graph.root, isLegacyPolicy(graph)]).toEqual([graph.root, isLegacyShape(graph)]);
  expect(isLegacyPolicy(undefined)).toBe(true);
});

test("the reported threshold does not depend on node declaration order", () => {
  const graph = composed(5);
  const reversed: PolicyGraph = { ...graph, nodes: [...graph.nodes].reverse() };
  // Only the exchange trade reaches the receiver, so the Chainlink bound of
  // 90000 must never be mistaken for the reported threshold.
  expect(reportedThreshold(graph, 1)).toBe(3000);
  expect(reportedThreshold(reversed, 1)).toBe(3000);
});

test("the tightest upper bound on the reported observation wins", () => {
  const graph: PolicyGraph = {
    nodes: [
      { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
      { id: "loose", kind: "compare", input: "eth", op: "<", value: 5000 },
      { id: "tight", kind: "compare", input: "eth", op: "<=", value: 2800 },
      { id: "both", kind: "and", inputs: ["loose", "tight"] },
    ],
    root: "both",
    action: { type: "pause-vault" },
  };
  expect(reportedThreshold(graph, 1)).toBe(2800);
  expect(reportedThreshold({ ...graph, nodes: [...graph.nodes].reverse() }, 1)).toBe(2800);
});

test("a policy with no upper bound on the reported observation keeps the fallback", () => {
  const graph: PolicyGraph = {
    nodes: [
      { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
      { id: "above", kind: "compare", input: "eth", op: ">", value: 1000 },
    ],
    root: "above",
    action: { type: "pause-vault" },
  };
  expect(reportedThreshold(graph, 4242)).toBe(4242);
});
