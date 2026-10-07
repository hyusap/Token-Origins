import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GRAPH_VERSION, REPORT_VERSION, NETWORK_IDS, MAX_SOURCES } from "../cre/graph";

// Bump when semantic argument/behavior compatibility changes.
// 6: frozen evaluation-only invocation cannot be stripped into a broadcast-enabled run.
export const SEMANTIC_API_VERSION = 6;
export const runtime = {
  semanticApiVersion: SEMANTIC_API_VERSION,
  graphVersion: GRAPH_VERSION,
  reportVersion: REPORT_VERSION,
  supports: {
    executionAuthority: "chainlink-cre",
    evaluationOnly: true,
    actions: ["pause-vault"],
    sources: ["exchange-trade:SYMBOL-USD", ...NETWORK_IDS.map((network) => `chainlink-feed:${network}`)],
    maxSources: MAX_SOURCES,
  },
  startedAt: new Date().toISOString(),
  pid: process.pid,
  sourceFingerprint: createHash("sha256")
    .update(["schemas.ts", "engine.ts", "sources.ts", "migrate.ts", "../cre/graph.ts", "../cre/spec.ts", "../cre/runner.ts", "policy-executor.ts", "predicate-reader.ts", "solana.ts", "monitor.ts", "evm-trades.ts", "evm-trade-watch.ts", "evm-trade-watch-adapter.ts", "trade-tools.ts", "../shared/execution-target.ts", "../shared/solana-types.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n"))
    .digest("hex"),
};
