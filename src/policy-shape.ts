import type { PolicyGraph } from "../shared/types";

/**
 * Browser-side mirror of isLegacyShape in cre/graph.ts. It is duplicated rather
 * than imported so the bundle stays free of the validation schema and zod; a
 * differential test pins the two against each other, because an earlier
 * hand-copied mirror silently inverted and sent every composed policy to the
 * scalar panel.
 */
export function isLegacyPolicy(graph: PolicyGraph | undefined): boolean {
  if (!graph) return true;
  if (graph.nodes.length !== 2) return false;
  const nodes = graph.nodes as Record<string, any>[];
  const compare = nodes.find((n) => n.kind === "compare");
  const price = nodes.find((n) => n.kind === "price");
  return Boolean(
    compare &&
      price &&
      compare.input === price.id &&
      compare.op === "<" &&
      graph.root === compare.id &&
      price.source?.type === "exchange-trade",
  );
}
