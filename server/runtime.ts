import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Bump when semantic argument/behavior compatibility changes.
export const SEMANTIC_API_VERSION = 2;
export const runtime = {
  semanticApiVersion: SEMANTIC_API_VERSION,
  startedAt: new Date().toISOString(),
  pid: process.pid,
  sourceFingerprint: createHash("sha256")
    .update(["schemas.ts", "engine.ts", "sources.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n"))
    .digest("hex"),
};
