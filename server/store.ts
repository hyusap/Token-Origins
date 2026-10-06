import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { CanvasState, ToolResult } from "../shared/types";

export class StateStore {
  db: Database;
  constructor(path = process.env.STATE_DB || ".data/origins.sqlite") {
    if (path !== ":memory:")
      mkdirSync(path.slice(0, path.lastIndexOf("/")) || ".", {
        recursive: true,
      });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
  }
  load(): CanvasState | null {
    const row = this.db
      .query("SELECT payload FROM states WHERE id=1")
      .get() as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
  }
  save(state: CanvasState) {
    this.db
      .query(
        "INSERT INTO states(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(state));
    for (const run of state.runs)
      this.db
        .query(
          "INSERT INTO executions(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        )
        .run(run.id, JSON.stringify(run));
  }
  operation(id: string): { signature: string; result: ToolResult } | null {
    const row = this.db
      .query("SELECT signature,payload FROM operations WHERE id=?")
      .get(id) as { signature: string; payload: string } | null;
    return row
      ? { signature: row.signature, result: JSON.parse(row.payload) }
      : null;
  }
  remember(id: string, signature: string, result: ToolResult) {
    this.db
      .query("INSERT INTO operations(id,signature,payload) VALUES(?,?,?)")
      .run(id, signature, JSON.stringify(result));
  }
}
