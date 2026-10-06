import type { GraphObject, PricePoint } from "../shared/types";

export interface ExecutionPriceObservation {
  usd: number;
  observedAt: string;
  source: string;
}

/** Keep exact runner inputs separate from the canvas's accumulated exchange observations. */
export function buildExecutionPrice(
  prior: GraphObject,
  observation: ExecutionPriceObservation,
  fetchedAt: string,
): { input: GraphObject; canvas: GraphObject } {
  if (
    !Number.isFinite(observation.usd) ||
    observation.usd <= 0 ||
    !Number.isFinite(Date.parse(observation.observedAt))
  )
    throw new Error("Invalid runner price observation");
  const point: PricePoint = {
    price: observation.usd,
    observedAt: observation.observedAt,
  };
  const provenance = {
    ...prior.provenance,
    source: observation.source.startsWith("http")
      ? "Coinbase Exchange"
      : observation.source,
    url: observation.source.startsWith("http")
      ? observation.source
      : prior.provenance.url,
    observedAt: observation.observedAt,
    fetchedAt,
    kind: "live" as const,
    label: "Live exchange observation · execution input",
  };
  const input: GraphObject = {
    ...structuredClone(prior),
    data: {
      price: observation.usd,
      unit: "USD",
      symbol: "ETH",
      history: [structuredClone(point)],
      historyLabel: "Actual execution observation",
    },
    provenance,
  };
  const { tradeId: _staleTradeId, ...priorData } = structuredClone(prior.data);
  const actualPoints = [
    ...(Array.isArray(priorData.history) ? priorData.history : []),
    point,
  ].filter(
    (p: any) =>
      Number.isFinite(p.price) &&
      p.price > 0 &&
      typeof p.observedAt === "string" &&
      Number.isFinite(Date.parse(p.observedAt)),
  );
  const distinct = new Map<string, PricePoint>();
  for (const p of actualPoints)
    distinct.set(`${p.observedAt}|${p.price}`, {
      price: p.price,
      observedAt: p.observedAt,
    });
  const history = [...distinct.values()]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .slice(-100);
  const canvas: GraphObject = {
    ...structuredClone(prior),
    data: {
      ...priorData,
      price: observation.usd,
      history,
      historyLabel: "Actual exchange observations · latest 100",
    },
    provenance: structuredClone(provenance),
  };
  return { input, canvas };
}
