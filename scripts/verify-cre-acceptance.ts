/** Product acceptance: real backend/MCP boundary, actual CRE CLI live no-op,
 * and independent public receipt verification. Owns a temporary SQLite only.
 * Never signs standalone actions, resets a vault or changes the primary DB.
 * bun run scripts/verify-cre-acceptance.ts [--boundary-only]
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { legacyGraph, policyHash } from "../cre/graph";
import { CRE_UNAVAILABLE_PRODUCT_TOOLS } from "../server/schemas";
import { SEMANTIC_API_VERSION } from "../server/runtime";
import { verifyEvidenceFile } from "./verify-evidence";

export async function verifyCreAcceptance(boundaryOnly = false) {
  const root = resolve(import.meta.dir, "..");
  const folder = await mkdtemp(resolve(tmpdir(), "woga-cre-acceptance-"));
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => typeof row[1] === "string"));
  // Actual CRE no-op needs CLI authentication; never pass standalone signer keys.
  for (const key of ["CRE_ETH_PRIVATE_KEY", "ORIGINS_PRIVATE_KEY", "ORIGINS_SOLANA_PRIVATE_KEY"]) delete env[key];
  Object.assign(env, { PORT: String(port), STATE_DB: resolve(folder, "canvas.sqlite"),
    ORIGINS_BACKEND_URL: baseUrl, ORIGINS_EXECUTION_MODE: "cre",
    ORIGINS_SOLANA_DATA_DIR: resolve(folder, "solana"), ORIGINS_EVM_TRADE_DATA_DIR: resolve(folder, "evm"),
    ORIGINS_EVM_TRADE_VENUES_FILE: resolve(folder, "empty-venues.json") });
  const checks: { check: string; passed: true; detail?: unknown }[] = [];
  const pass = (check: string, detail?: unknown) => { checks.push({ check, passed: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${check}`); };
  const spawnBackend = () => Bun.spawn([Bun.which("bun")!, "--no-env-file", "run", "server/index.ts"], { cwd: root, env,
    stdout: Bun.file(resolve(folder, "backend.log")), stderr: Bun.file(resolve(folder, "backend-error.log")) });
  let child = spawnBackend();
  const stopBackend = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (!await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)])) { child.kill("SIGKILL"); await child.exited; }
  };
  const healthReady = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, `Backend exited before ready; logs ${folder}`);
      try { return await (await fetch(`${baseUrl}/api/health`)).json(); } catch { await Bun.sleep(100); }
    }
    throw new Error(`Backend readiness timeout; logs ${folder}`);
  };
  let client: Client | undefined;
  try {
    const health: any = await healthReady();
    assert.equal(health?.runtime.semanticApiVersion, SEMANTIC_API_VERSION);
    assert.equal(health.runtime.supports.executionAuthority, "chainlink-cre");
    assert.deepEqual(health.runtime.supports.actions, ["pause-vault"]);
    pass("real backend exposes CRE-only semantic API", { version: SEMANTIC_API_VERSION, fingerprint: health.runtime.sourceFingerprint });
    const readiness = await (await fetch(`${baseUrl}/api/cre/capabilities`)).json() as any;
    assert.equal(readiness.executionAuthority, "chainlink-cre");
    assert.equal(readiness.donDeployed, false);
    assert.equal(readiness.readyForEvaluation, Boolean(readiness.cliInstalled && readiness.authenticated && readiness.receiver));
    assert.equal(readiness.broadcastConfigured, false, "Isolated QA omits standalone/private signing keys");
    pass("readiness reports actual CLI authentication and distinguishes DON deployment", readiness);
    const definitions = await (await fetch(`${baseUrl}/api/tools`)).json() as Record<string, unknown>;
    for (const name of CRE_UNAVAILABLE_PRODUCT_TOOLS) {
      assert.ok(!(name in definitions), `HTTP manifest must exclude ${name}`);
      const denied = await fetch(`${baseUrl}/api/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: "denied" }) });
      assert.equal(denied.status, 404, `${name} must have no public HTTP route`);
    }
    pass("HTTP manifest and routes exclude every standalone signer utility", { excluded: [...CRE_UNAVAILABLE_PRODUCT_TOOLS] });
    const transport = new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", resolve(root, "scripts/mcp.ts")], env, stderr: "pipe" });
    client = new Client({ name: "cre-product-acceptance", version: "1" });
    await client.connect(transport);
    const advertised = (await client.listTools()).tools;
    for (const name of CRE_UNAVAILABLE_PRODUCT_TOOLS) assert.ok(!advertised.some(tool => tool.name === name));
    for (const name of ["transfer_solana_devnet", "copy_evm_swap", "activate_evm_trade_watch"]) {
      let rejected = false;
      try { const denied = await client.callTool({ name, arguments: { operationId: "denied" } }); rejected = Boolean(denied.isError); } catch { rejected = true; }
      assert.ok(rejected, `MCP must refuse ${name}`);
    }
    pass("official MCP refuses unavailable direct action tools");
    const unsupportedGraph = { ...legacyGraph(1, "SOL-USD"), action: { type: "solana-transfer", network: "devnet", recipient: "11111111111111111111111111111111", amountLamports: 1 } };
    const rejected = await fetch(`${baseUrl}/api/tools/compose_graph`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph: unsupportedGraph, expectedRevision: 0, operationId: "unsupported-graph" }) });
    assert.equal(rejected.status, 400);
    const initial = await (await fetch(`${baseUrl}/api/state`)).json() as any;
    assert.equal(initial.workflow.revision, 0); assert.equal(initial.runs.length, 0);
    pass("direct Solana graph cannot mutate draft or queue execution");
    let liveMonitor: unknown, monitorAfterRestart: unknown, publicProof: unknown;
    if (!boundaryOnly) {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args });
        const value = result.structuredContent as any;
        assert.ok(!result.isError && value?.ok, `${name}: ${value?.error || value?.summary || JSON.stringify(result.content)}`);
        return value;
      };
      await call("discover_objects", { objects: ["price", "vault"], tokens: ["ETH"], operationId: "live-discovery" });
      // Contradictory comparisons guarantee false for every numeric price.
      // The guard cannot become true because of a market move during QA.
      const base = legacyGraph(1, "ETH-USD");
      const graph = { ...base, nodes: [...base.nodes,
        { id: "at-least-one", kind: "compare" as const, input: "eth", op: ">=" as const, value: 1 },
        { id: "impossible-and", kind: "and" as const, inputs: [base.root, "at-least-one"] }], root: "impossible-and" };
      await call("compose_graph", { expectedRevision: 0, graph, operationId: "cre-false-compose" });
      const started = await call("activate_policy", { expectedRevision: 1, intervalSeconds: 3600, operationId: "cre-false-monitor" });
      const monitorId = started.data.monitor.id;
      // Draft edits must not alter the rule whose checks are already scheduled.
      await call("compose_graph", { expectedRevision: 1, graph: legacyGraph(0.000001, "ETH-USD"), operationId: "later-draft" });
      let monitor: any;
      for (let attempt = 0; attempt < 500; attempt++) {
        const state = await (await fetch(`${baseUrl}/api/state`)).json() as any;
        monitor = state.monitors.find((item: any) => item.id === monitorId);
        if (monitor?.latestEvidence || monitor?.lastError) break;
        await Bun.sleep(500);
      }
      assert.ok(monitor?.latestEvidence, monitor?.lastError || `CRE observation did not settle; logs ${folder}`);
      await call("deactivate_policy", { monitorId, operationId: "stop-false-monitor" });
      assert.equal(monitor.target.executor, "cre"); assert.equal(monitor.target.chainId, 11155111);
      assert.equal(monitor.spec.revision, 1); assert.equal(monitor.spec.policyHash, policyHash(graph));
      assert.equal(monitor.latestEvidence.mode, "cre-local-simulation"); assert.equal(monitor.latestEvidence.decision, "noop");
      assert.equal(monitor.latestEvidence.root, false); assert.ok(!monitor.latestEvidence.transaction);
      assert.ok(monitor.latestEvidence.observations.some((observation: any) => observation.key === "exchange-trade:ETH-USD" && observation.usd > 0));
      liveMonitor = monitor;
      pass("actual CRE CLI evaluates frozen contradictory policy from live exchange and real Sepolia receiver", { monitorId, policyHash: monitor.spec.policyHash, noTransaction: true });
      pass("later draft edit does not alter active CRE policy authority or graph");
      const replay = await call("activate_policy", { expectedRevision: 1, intervalSeconds: 3600, operationId: "cre-false-monitor" });
      assert.equal(replay.data.monitor.id, monitorId); assert.equal(replay.duplicate, true);
      await stopBackend(); child = spawnBackend();
      const restarted = await healthReady();
      assert.equal(restarted.sessionId, health.sessionId);
      const saved = await call("get_monitors", { monitorId });
      const afterRestart = saved.data.monitors[0];
      assert.equal(afterRestart.status, "paused"); assert.equal(afterRestart.checks, monitor.checks);
      assert.deepEqual(afterRestart.latestEvidence, monitor.latestEvidence);
      monitorAfterRestart = afterRestart;
      pass("SQLite restart preserves stopped monitor and exact CRE evidence without reactivation", { status: afterRestart.status, checks: afterRestart.checks, monitorId });
      pass("original activation retry deduplicates rather than granting new scheduling authority");
      // Verify the newest saved public execution for the actual frozen receiver.
      // Historical proofs from other deployments cannot stand in for this one.
      const proofNames = await Array.fromAsync(new Bun.Glob("sepolia-evidence-*.json").scan({ cwd: resolve(root, "demo"), onlyFiles: true }));
      let proofPath: string | undefined;
      for (const name of proofNames.sort().reverse()) {
        const path = resolve(root, "demo", name);
        const candidate = await Bun.file(path).json();
        if (candidate.chainId === 11155111 && candidate.vault?.toLowerCase() === monitor.target.address.toLowerCase()) { proofPath = path; break; }
      }
      assert.ok(proofPath, "No saved public CRE execution exists for the current frozen receiver");
      publicProof = await verifyEvidenceFile(proofPath);
      assert.equal((publicProof as any).verified, true);
      assert.equal((publicProof as any).vault.toLowerCase(), monitor.target.address.toLowerCase());
      pass("existing public CRE broadcast is independently verified against Sepolia", publicProof);
    }
    return { verified: true, acceptedProductProof: true, scope: boundaryOnly ? "CRE-only semantic boundary; live execution not tested" : "CRE CLI simulation with live inputs; historical public CRE broadcast reverified; DON deployment not claimed",
      verifiedAt: new Date().toISOString(), temporaryDirectory: folder, isolatedBackend: baseUrl,
      checks, ...(liveMonitor ? { liveMonitor } : {}), ...(monitorAfterRestart ? { monitorAfterRestart } : {}), ...(publicProof ? { publicProof } : {}) };
  } catch (error) {
    await Bun.write(resolve(root, "demo/cre-acceptance-failed.json"), JSON.stringify({ verified: false, acceptedProductProof: false,
      verifiedAt: new Date().toISOString(), checks, temporaryDirectory: folder,
      error: error instanceof Error ? error.message : String(error) }, null, 2));
    throw error;
  } finally {
    await client?.close();
    await stopBackend();
  }
}

if (import.meta.main) {
  const boundaryOnly = process.argv.includes("--boundary-only");
  const artifact = resolve(import.meta.dir, "../demo", boundaryOnly ? "cre-boundary-verification.json" : "cre-acceptance-verification.json");
  const result = await verifyCreAcceptance(boundaryOnly);
  await Bun.write(artifact, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ verified: result.verified, checks: result.checks.length, artifact }));
}
