import { test, expect } from "bun:test";
import { buildExecutionPrice } from "../server/execution-price";
import type { GraphObject } from "../shared/types";
const prior = (): GraphObject => ({
  id: "price:eth-usd",
  kind: "price",
  label: "ETH / USD",
  visible: true,
  pinned: true,
  data: {
    price: 2700,
    tradeId: 123456,
    unit: "USD",
    symbol: "ETH",
    history: [
      { price: 2700, observedAt: "2026-10-06T05:00:00Z" },
      { price: 2699, observedAt: "2026-10-06T04:59:00Z" },
    ],
  },
  provenance: {
    source: "Coinbase Exchange",
    url: "https://api.exchange.coinbase.com/products/ETH-USD/trades?limit=100",
    observedAt: "2026-10-06T05:00:00Z",
    fetchedAt: "2026-10-06T05:00:01Z",
    kind: "live",
    label: "Test exchange observations",
  },
});

test("execution observation replaces stale trade metadata and appends only actual chart points without mutating prior", () => {
  const original = prior();
  const before = structuredClone(original);
  const observation = {
    usd: 2702.51,
    observedAt: "2026-10-06T05:08:00.123456789Z",
    source: "https://api.exchange.coinbase.com/products/ETH-USD/ticker",
  };
  const { input, canvas } = buildExecutionPrice(
    original,
    observation,
    "2026-10-06T05:08:01Z",
  );
  expect(input.data.tradeId).toBeUndefined();
  expect(canvas.data.tradeId).toBeUndefined();
  expect(input.data.history).toEqual([
    { price: 2702.51, observedAt: observation.observedAt },
  ]);
  expect(canvas.data.history).toEqual([
    { price: 2699, observedAt: "2026-10-06T04:59:00Z" },
    { price: 2700, observedAt: "2026-10-06T05:00:00Z" },
    { price: 2702.51, observedAt: observation.observedAt },
  ]);
  expect(input.provenance.observedAt).toBe(observation.observedAt);
  expect(canvas.provenance.url).toBe(observation.source);
  expect(original).toEqual(before);
  canvas.data.history.at(-1).price = 1;
  expect(input.data.history[0].price).toBe(2702.51);
});

test("chart deduplicates actual timestamp-price pairs and retains latest 100 observations", () => {
  const original = prior();
  original.data.history = Array.from({ length: 105 }, (_, i) => ({
    price: 2600 + i,
    observedAt: new Date(Date.UTC(2026, 9, 6, 5, 0, i)).toISOString(),
  }));
  const same = original.data.history.at(-1);
  const dedup = buildExecutionPrice(
    original,
    {
      usd: same.price,
      observedAt: same.observedAt,
      source: "Coinbase Exchange",
    },
    "2026-10-06T05:02:00Z",
  );
  expect(dedup.canvas.data.history).toHaveLength(100);
  expect(dedup.canvas.data.history[0]).toEqual(original.data.history[5]);
  expect(dedup.canvas.data.history.at(-1)).toEqual(same);
  expect(original.data.history).toHaveLength(105);
  const appended = buildExecutionPrice(
    dedup.canvas,
    {
      usd: 2800,
      observedAt: "2026-10-06T05:03:00Z",
      source: "Coinbase Exchange",
    },
    "2026-10-06T05:03:01Z",
  );
  expect(appended.canvas.data.history).toHaveLength(100);
  expect(appended.canvas.data.history.at(-1)).toEqual({
    price: 2800,
    observedAt: "2026-10-06T05:03:00Z",
  });
  expect(appended.canvas.data.history[0]).toEqual(original.data.history[6]);
});
