import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanvasState, ExecutionRun, ToolResult } from "../shared/types";

export class StateStore {
  db: Database;
  constructor(path = process.env.STATE_DB || ".data/origins.sqlite") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), {
        recursive: true,
      });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cleared_sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, cleared_at INTEGER NOT NULL)",
    );
  }
  load(): CanvasState | null {
    const row = this.db
      .query("SELECT payload FROM states WHERE id=1")
      .get() as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
  }
  save(state: CanvasState) {
    this.db.transaction(() => {
      this.db.query("INSERT INTO states(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(state));
      const saveRun = this.db.query("INSERT INTO executions(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload");
      for (const run of state.runs) saveRun.run(run.id, JSON.stringify(run));
    })();
  }
  /** A run from the archive: every run ever saved, including ones trimmed from the live state. */
  execution(id: string): ExecutionRun | null {
    const row = this.db.query("SELECT payload FROM executions WHERE id=?").get(id) as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
  }
  archiveSession(state: CanvasState) {
    this.db.query("INSERT INTO cleared_sessions(id,payload,cleared_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(state.sessionId, JSON.stringify(state), Date.now());
  }
  latestClearedSession(): CanvasState | null {
    const row = this.db.query("SELECT payload FROM cleared_sessions ORDER BY cleared_at DESC, rowid DESC LIMIT 1").get() as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
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
