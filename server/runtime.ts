import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GRAPH_VERSION, REPORT_VERSION, NETWORK_IDS, MAX_SOURCES } from "../cre/graph";

// Bump when semantic argument/behavior compatibility changes.
// 3: network-bound feeds, structural policy hashes, report v2, fresh runs after completion.
export const SEMANTIC_API_VERSION = 3;
export const runtime = {
  semanticApiVersion: SEMANTIC_API_VERSION,
  graphVersion: GRAPH_VERSION,
  reportVersion: REPORT_VERSION,
  supports: {
    actions: ["pause-vault", "sell (simulated, local rehearsal only)"],
    sources: ["exchange-trade:ETH-USD", ...NETWORK_IDS.map((network) => `chainlink-feed:${network}`)],
    maxSources: MAX_SOURCES,
  },
  startedAt: new Date().toISOString(),
  pid: process.pid,
  sourceFingerprint: createHash("sha256")
    .update(["schemas.ts", "engine.ts", "sources.ts", "migrate.ts", "../cre/graph.ts", "../cre/spec.ts", "../cre/runner.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n"))
    .digest("hex"),
};
