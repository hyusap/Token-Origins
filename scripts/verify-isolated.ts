/** Real integration validation. Owns only its temporary Anvil/backend/SQLite.
 * No source adapters, prices, receipts or contract reads are mocked.
 * Run: bun run scripts/verify-isolated.ts
 * Historical direct-execution research only. Current product requires CRE.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, createWalletClient, http, parseEther, parseAbi, decodeEventLog, keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { CanvasState, ExecutionRun } from '../shared/types';
import { policyHash } from '../cre/graph';

if (process.env.ORIGINS_QA_RESEARCH_ONLY !== '1') {
  throw new Error('This harness exercises historical direct local executors, outside the CRE-only product. Explicit research requires ORIGINS_QA_RESEARCH_ONLY=1; use CRE acceptance checks for product verification.');
}

const root = resolve(import.meta.dir, '..');
const folder = await mkdtemp(resolve(tmpdir(), 'woga-real-e2e-'));
const artifactPath = resolve(root, 'demo/isolated-e2e-verification.json');
const publicKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const inherited = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => typeof row[1] === 'string'));
// Intentionally omit all public-network signing credentials from subprocesses.
for (const key of ['CRE_API_KEY', 'CRE_ETH_PRIVATE_KEY', 'ORIGINS_PRIVATE_KEY']) delete inherited[key];
const children: ReturnType<typeof Bun.spawn>[] = [];
let mcp: Client | undefined;
let backend: ReturnType<typeof Bun.spawn> | undefined;
let chain: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
let websocketStates = 0;
const reportingSnapshots = new Map<string, CanvasState>();
const monitorBroadcastSnapshots = new Map<string, unknown>();
function captureState(event: MessageEvent) {
  const message = JSON.parse(String(event.data));
  if (message.type !== 'state') return;
  websocketStates++;
  for (const run of message.state.runs as ExecutionRun[]) {
    if (run.status === 'reporting' && !run.evidence?.transactionHash) reportingSnapshots.set(run.id, message.state);
  }
  for (const monitor of message.state.monitors || []) {
    if (monitor.phase === 'broadcast' && monitor.status === 'checking') monitorBroadcastSnapshots.set(monitor.id, monitor);
  }
}
const steps: { check: string; passed: true; detail?: unknown }[] = [];
const pass = (check: string, detail?: unknown) => { steps.push({ check, passed: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${check}`); };

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
const chainPort = await unusedPort();
const backendPort = await unusedPort();
const rpcUrl = `http://127.0.0.1:${chainPort}`;
const baseUrl = `http://127.0.0.1:${backendPort}`;
const deploymentPath = resolve(folder, 'deployment.json');
const statePath = resolve(folder, 'anvil-state.json');
const env = { ...inherited, PORT: String(backendPort), STATE_DB: resolve(folder, 'canvas.sqlite'), DEPLOYMENT_FILE: deploymentPath, ORIGINS_EXECUTION_MODE: 'local', ORIGINS_BACKEND_URL: baseUrl, ORIGINS_SOLANA_DATA_DIR: resolve(folder, 'solana') };
console.log(JSON.stringify({ isolatedWorkspace: folder, rpcUrl, backendUrl: baseUrl, deploymentFile: deploymentPath }));
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(publicKey) });
const abi = parseAbi(['function paused() view returns (bool)', 'function resume()', 'function processedRuns(bytes32) view returns (bool)', 'event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)']);
async function ready(probe: () => Promise<unknown>, child: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Child exited ${child.exitCode} before readiness. Logs: ${folder}`);
    try { await probe(); return; } catch { await Bun.sleep(100); }
  }
  throw new Error(`Process readiness timed out. Logs: ${folder}`);
}
async function stop(child: ReturnType<typeof Bun.spawn> | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!ended) { child.kill('SIGKILL'); await child.exited; }
}
async function startChain() {
  // --state preserves receipts, contract state and historical execution data.
  const child = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(chainPort), '--chain-id', '31337', '--state', statePath, '--preserve-historical-states', '--silent'], { cwd: root, env, stdout: Bun.file(resolve(folder, 'chain.log')), stderr: Bun.file(resolve(folder, 'chain-error.log')) });
  children.push(child); chain = child;
  await ready(() => publicClient.getChainId(), child);
  assert.equal(await publicClient.getChainId(), 31337);
}
async function startBackend() {
  const child = Bun.spawn([Bun.which('bun')!, 'run', 'server/index.ts'], { cwd: root, env, stdout: Bun.file(resolve(folder, 'backend.log')), stderr: Bun.file(resolve(folder, 'backend-error.log')) });
  children.push(child); backend = child;
  await ready(async () => { const response = await fetch(`${baseUrl}/api/health`); assert.equal(response.status, 200); }, child);
}
async function state(): Promise<CanvasState> { return await (await fetch(`${baseUrl}/api/state`)).json() as CanvasState; }
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp!.callTool({ name, arguments: args });
  if (result.isError && !result.structuredContent) throw new Error(`${name}: ${(result.content as any)[0]?.text || 'MCP error'}`);
  const value: any = result.structuredContent ?? JSON.parse((result.content as any)[0].text);
  if (result.isError || !value.ok) throw new Error(`${name}: ${value.error || value.summary || 'Tool failed'}`);
  return value;
}
async function complete(runId: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const run = (await state()).runs.find(row => row.id === runId);
    if (run && ['confirmed', 'no-op', 'failed'].includes(run.status)) { assert.notEqual(run.status, 'failed', run.error || 'Run failed'); return run; }
    await Bun.sleep(250);
  }
  throw new Error(`Run ${runId} did not finish within 60 seconds`);
}
const graph = (eth: number, sol: number) => ({ nodes: [
  { id: 'eth', kind: 'price', source: { type: 'exchange-trade', pair: 'ETH-USD' } },
  { id: 'sol', kind: 'price', source: { type: 'exchange-trade', pair: 'SOL-USD' } },
  { id: 'eth-low', kind: 'compare', input: 'eth', op: '<', value: eth },
  { id: 'sol-low', kind: 'compare', input: 'sol', op: '<', value: sol },
  { id: 'both', kind: 'and', inputs: ['eth-low', 'sol-low'] },
], root: 'both', action: { type: 'pause-vault' } });
let confirmed: ExecutionRun | undefined;
const additionalRuns: ExecutionRun[] = [];
let monitorProof: unknown;
let publicSolanaPolicy: { status: 'verified' | 'blocked'; [key: string]: unknown } | undefined;
let semanticApiVersion = 0;
try {
  const build = Bun.spawn(['forge', 'build', '--root', 'contracts'], { cwd: root, stdout: 'ignore', stderr: 'pipe' });
  assert.equal(await build.exited, 0, await new Response(build.stderr).text());
  await startChain();
  const f = await Bun.file(resolve(root, 'contracts/out/LocalRehearsalForwarder.sol/LocalRehearsalForwarder.json')).json();
  const v = await Bun.file(resolve(root, 'contracts/out/GrantVault.sol/GrantVault.json')).json();
  const forwarderReceipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: f.abi, bytecode: f.bytecode.object, args: [] }) });
  const vaultReceipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: v.abi, bytecode: v.bytecode.object, args: [forwarderReceipt.contractAddress!, 120n], value: parseEther('1.2049') }) });
  assert.equal(vaultReceipt.status, 'success');
  const address = vaultReceipt.contractAddress!;
  await Bun.write(deploymentPath, JSON.stringify({ address, forwarder: forwarderReceipt.contractAddress, owner: wallet.account.address, chainId: 31337, rpcUrl, mode: 'local-evm-rehearsal' }));
  pass('fresh isolated contracts deployed', { rpcUrl, address, block: String(vaultReceipt.blockNumber) });
  await startBackend();
  const health = await (await fetch(`${baseUrl}/api/health`)).json() as any;
  semanticApiVersion = health.runtime.semanticApiVersion;
  assert.ok(semanticApiVersion >= 4, 'Acceptance requires immutable multi-chain semantic API4');
  assert.ok(health.runtime.supports.actions.includes('solana-transfer:devnet'));
  pass('backend advertises immutable multi-chain semantic API4', { semanticApiVersion, actions: health.runtime.supports.actions });
  mcp = new Client({ name: 'real-e2e', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: Bun.which('bun')!, args: [resolve(root, 'scripts/mcp.ts')], cwd: root, env, stderr: 'pipe' }));
  socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws');
  socket.onmessage = captureState;
  await call('discover_objects', { objects: ['price', 'vault'], tokens: ['ETH', 'SOL', 'BTC'], operationId: 'e2e-discovery' });
  const discovered = await state();
  const vault = discovered.objects.find(row => row.id === 'vault:grant')!;
  assert.equal(vault.data.fixture, false);
  assert.equal(vault.data.address.toLowerCase(), address.toLowerCase());
  for (const symbol of ['eth', 'sol', 'btc']) {
    const price = discovered.objects.find(row => row.id === `price:${symbol}-usd`)!;
    assert.equal(price.provenance.kind, 'live');
    assert.ok(price.data.price > 0);
    assert.ok(price.data.history.length > 0);
    assert.ok(Math.abs(Date.now() - Date.parse(price.provenance.observedAt)) < 120000);
  }
  pass('official MCP discovers live ETH/SOL/BTC and the same deployed vault', discovered.objects.filter(row => row.kind === 'price').map(row => ({ id: row.id, usd: row.data.price, source: row.provenance.source, observedAt: row.provenance.observedAt })));
  const bad = await mcp.callTool({ name: 'discover_objects', arguments: { objects: ['price'], tokens: ['NOT-A-REAL-WOGA-ASSET'], operationId: 'e2e-unknown' } });
  assert.equal(bad.isError, true);
  assert.equal((await state()).objects.filter(row => row.kind === 'price').length, 3);
  pass('unsupported asset fails without fabricating another price');
  await call('compose_graph', { expectedRevision: 0, graph: graph(0.0001, 0.0001), operationId: 'e2e-false-compose' });
  const beforeFalse = await publicClient.getTransactionCount({ address: wallet.account.address });
  const falseRun = await complete((await call('run_workflow', { expectedRevision: 1, operationId: 'e2e-false-run' })).runId);
  assert.equal(falseRun.status, 'no-op');
  assert.equal(falseRun.evidence?.transactionHash, undefined);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeFalse);
  assert.equal(await publicClient.readContract({ address, abi, functionName: 'paused' }), false);
  pass('false composed policy produces no transaction', { runId: falseRun.id });
  const eth = discovered.objects.find(row => row.id === 'price:eth-usd')!.data.price;
  const sol = discovered.objects.find(row => row.id === 'price:sol-usd')!.data.price;
  const trueGraph = graph(eth * 2, sol * 2);
  await call('compose_graph', { expectedRevision: 1, graph: trueGraph, operationId: 'e2e-true-compose' });
  const runArgs = { expectedRevision: 2, operationId: 'e2e-true-run' };
  const runId = (await call('run_workflow', runArgs)).runId;
  // Edit while this exact immutable snapshot is executing.
  await call('compose_graph', { expectedRevision: 2, graph: graph(0.0001, 0.0001), operationId: 'e2e-inflight-edit' });
  confirmed = await complete(runId);
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.snapshot.graph, trueGraph);
  assert.equal((await state()).workflow.revision, 3);
  const txHash = confirmed.evidence!.transactionHash as Hex;
  assert.ok(txHash);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  assert.equal(receipt.status, 'success');
  const id = keccak256(toBytes(confirmed.id));
  const events = receipt.logs.filter(row => row.address.toLowerCase() === address.toLowerCase()).map(row => decodeEventLog({ abi, data: row.data, topics: row.topics }));
  assert.ok(events.some(row => row.eventName === 'SpendingPaused' && row.args.runId === id && row.args.revision === 2n && row.args.policyHash === policyHash(confirmed!.snapshot.graph)));
  assert.equal(confirmed.observations?.length, 2);
  assert.equal(await publicClient.readContract({ address, abi, functionName: 'paused' }), true);
  assert.equal(await publicClient.readContract({ address, abi, functionName: 'processedRuns', args: [id] }), true);
  pass('true multi-asset graph mines correlated policy hash and pause event', { runId, hash: txHash, block: String(receipt.blockNumber), graphFrozenWhileDraftEdited: true });
  const beforeReplay = await publicClient.getTransactionCount({ address: wallet.account.address });
  assert.equal((await call('run_workflow', runArgs)).runId, runId);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeReplay);
  pass('exact operation replay returns immutable run without a transaction');
  await call('compose_graph', { expectedRevision: 3, graph: trueGraph, operationId: 'e2e-paused-compose' });
  const paused = await complete((await call('run_workflow', { expectedRevision: 4, operationId: 'e2e-paused-run' })).runId);
  assert.equal(paused.status, 'no-op');
  assert.equal(paused.evidence?.transactionHash, undefined);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeReplay);
  pass('already-paused guard prevents another on-chain action');
  assert.ok(websocketStates > 4);
  pass('real WebSocket pushes execution state', { receivedStates: websocketStates });
  socket.close(); socket = undefined;
  await stop(backend); await startBackend();
  const restarted = await state();
  assert.equal(restarted.workflow.revision, 4);
  assert.deepEqual(restarted.runs.find(row => row.id === runId)?.evidence, confirmed.evidence);
  assert.equal((await call('run_workflow', runArgs)).runId, runId);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeReplay);
  pass('SQLite and operation dedup survive backend restart');
  await stop(chain); await startChain();
  const restoredReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
  assert.deepEqual(restoredReceipt.logs, receipt.logs);
  assert.equal(restoredReceipt.blockHash, receipt.blockHash);
  assert.equal(await publicClient.readContract({ address, abi, functionName: 'paused', blockNumber: receipt.blockNumber }), true);
  assert.equal(await publicClient.readContract({ address, abi, functionName: 'processedRuns', args: [id] }), true);
  pass('real node restart preserves receipt, correlated events and historical vault state');
  // Exercise the remaining boolean vocabulary against real prices/contracts.
  // Only this harness's own treasury is resumed between independent actions.
  async function executeAdditional(policy: unknown, name: string) {
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName: 'resume' }) });
    const revision = (await state()).workflow.revision;
    await call('compose_graph', { expectedRevision: revision, graph: policy, operationId: `e2e-${name}-compose` });
    const run = await complete((await call('run_workflow', { expectedRevision: revision + 1, operationId: `e2e-${name}-run` })).runId);
    assert.equal(run.status, 'confirmed');
    assert.ok(run.evidence?.transactionHash);
    assert.equal(await publicClient.readContract({ address, abi, functionName: 'paused' }), true);
    const transaction = await publicClient.getTransactionReceipt({ hash: run.evidence!.transactionHash as Hex });
    assert.equal(transaction.status, 'success');
    const policyId = keccak256(toBytes(run.id));
    const frozenHash = policyHash(run.snapshot.graph);
    assert.ok(transaction.logs.some(entry => {
      if (entry.address.toLowerCase() !== address.toLowerCase()) return false;
      try { const event = decodeEventLog({ abi, data: entry.data, topics: entry.topics }); return event.eventName === 'SpendingPaused' && event.args.runId === policyId && event.args.policyHash === frozenHash; } catch { return false; }
    }));
    additionalRuns.push(run);
    return run;
  }
  const booleanRun = await executeAdditional({ nodes: [
    { id: 'eth', kind: 'price', source: { type: 'exchange-trade', pair: 'ETH-USD' } },
    { id: 'sol', kind: 'price', source: { type: 'exchange-trade', pair: 'SOL-USD' } },
    { id: 'rising', kind: 'compare', input: 'eth', op: '>', value: 0.0001 },
    { id: 'low', kind: 'compare', input: 'sol', op: '<=', value: 0.0001 },
    { id: 'not-low', kind: 'not', input: 'low' },
    { id: 'either', kind: 'or', inputs: ['rising', 'not-low'] },
    { id: 'fresh', kind: 'freshness', input: 'eth', maxAgeSeconds: 60 },
    { id: 'both', kind: 'and', inputs: ['either', 'fresh'] },
  ], root: 'both', action: { type: 'pause-vault' } }, 'boolean');
  for (const kind of ['or', 'not', 'freshness']) assert.ok(booleanRun.decisions.some(row => row.id === kind && row.passed));
  pass('rising comparison, OR, NOT and explicit freshness execute a real report', { runId: booleanRun.id, hash: booleanRun.evidence!.transactionHash });
  const vaultOnly = await executeAdditional({ nodes: [{ id: 'active', kind: 'vault-paused', equals: false }], root: 'active', action: { type: 'pause-vault' } }, 'vault-only');
  assert.equal(vaultOnly.inputs?.price, undefined);
  assert.equal(vaultOnly.observations?.length, 0);
  assert.ok(vaultOnly.evidence?.contractAddress);
  assert.ok(!vaultOnly.logs.some(row => row.message.includes('Resolving Coinbase')));
  pass('vault-only graph executes without a fabricated price or exchange request', { runId: vaultOnly.id, hash: vaultOnly.evidence!.transactionHash });
  await call('read_price_feed', { symbol: 'BTC', network: 'ethereum-mainnet', operationId: 'e2e-real-oracle' });
  const oracleObject = (await state()).objects.find(row => row.id === 'feed:btc-usd')!;
  assert.equal(oracleObject.provenance.kind, 'chain');
  assert.equal(oracleObject.provenance.chainId, 1);
  const oracleRun = await executeAdditional({ nodes: [
    { id: 'eth', kind: 'price', source: { type: 'exchange-trade', pair: 'ETH-USD' } },
    { id: 'btc', kind: 'price', source: { type: 'chainlink-feed', symbol: 'BTC', network: 'ethereum-mainnet' } },
    { id: 'exchange', kind: 'compare', input: 'eth', op: '>=', value: 0.0001 },
    { id: 'oracle', kind: 'compare', input: 'btc', op: '>', value: 1 },
    { id: 'both', kind: 'and', inputs: ['exchange', 'oracle'] },
  ], root: 'both', action: { type: 'pause-vault' } }, 'oracle-exchange');
  assert.equal(oracleRun.observations?.length, 2);
  const oracle = oracleRun.observations!.find(row => row.provider === 'chainlink')!;
  assert.equal(oracle.chainId, 1);
  assert.ok(oracle.roundId);
  assert.equal(oracle.address?.toLowerCase(), oracleObject.provenance.address!.toLowerCase());
  pass('live mainnet Chainlink oracle and Coinbase trade compose into a real local-chain action', { runId: oracleRun.id, hash: oracleRun.evidence!.transactionHash, oracle: { address: oracle.address, chainId: oracle.chainId, roundId: oracle.roundId, observedAt: oracle.observedAt } });
  socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws');
  socket.onmessage = captureState;
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error('Monitor proof WebSocket failed')); });
  await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName: 'resume' }) });
  const solPolicy = (op: string) => ({ nodes: [
    { id: 'sol', kind: 'price', source: { type: 'exchange-trade', pair: 'SOL-USD' } },
    { id: 'trigger', kind: 'compare', input: 'sol', op, value: 0.0001 },
  ], root: 'trigger', action: { type: 'pause-vault' } });
  async function waitMonitor(id: string, predicate: (monitor: any) => boolean) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const monitor = (await call('get_monitors', { monitorId: id })).data.monitors[0];
      assert.ok(!['failed', 'uncertain'].includes(monitor.status), monitor.lastError || monitor.stopReason || 'Monitor failed');
      if (predicate(monitor)) return monitor;
      await Bun.sleep(250);
    }
    throw new Error(`Monitor ${id} did not reach expected state within 60 seconds`);
  }
  let monitorRevision = (await state()).workflow.revision;
  await call('compose_graph', { expectedRevision: monitorRevision, graph: solPolicy('<'), operationId: 'e2e-monitor-false-compose' });
  const beforeMonitor = await publicClient.getTransactionCount({ address: wallet.account.address });
  const falseActivation = await call('activate_policy', { expectedRevision: monitorRevision + 1, intervalSeconds: 15, operationId: 'e2e-monitor-false-activate' });
  const falseMonitor = await waitMonitor(falseActivation.data.monitor.id, row => row.checks >= 1 && row.status === 'active');
  assert.equal(falseMonitor.latestEvidence.decision, 'noop');
  assert.equal(falseMonitor.latestEvidence.transaction, undefined);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeMonitor);
  await call('deactivate_policy', { monitorId: falseMonitor.id, operationId: 'e2e-monitor-false-stop' });
  pass('activated false SOL policy checks live inputs without a transaction and deactivates');
  monitorRevision = (await state()).workflow.revision;
  await call('compose_graph', { expectedRevision: monitorRevision, graph: solPolicy('>'), operationId: 'e2e-monitor-true-compose' });
  const trueActivation = await call('activate_policy', { expectedRevision: monitorRevision + 1, intervalSeconds: 15, operationId: 'e2e-monitor-true-activate' });
  await call('compose_graph', { expectedRevision: monitorRevision + 1, graph: solPolicy('<'), operationId: 'e2e-monitor-concurrent-edit' });
  const trueMonitor = await waitMonitor(trueActivation.data.monitor.id, row => row.status === 'completed');
  assert.equal(trueMonitor.spec.policyHash, trueActivation.data.monitor.spec.policyHash);
  assert.equal(trueMonitor.latestEvidence.observations.length, 1);
  assert.equal(trueMonitor.latestEvidence.observations[0].key, 'exchange-trade:SOL-USD');
  const monitoredReceipt = await publicClient.getTransactionReceipt({ hash: trueMonitor.latestEvidence.transaction.hash as Hex });
  assert.equal(monitoredReceipt.status, 'success');
  assert.ok(monitoredReceipt.logs.some(entry => {
    if (entry.address.toLowerCase() !== address.toLowerCase()) return false;
    try { const event = decodeEventLog({ abi, data: entry.data, topics: entry.topics }); return event.eventName === 'SpendingPaused' && event.args.runId === keccak256(toBytes(trueMonitor.lastRunId)) && event.args.policyHash === trueMonitor.spec.policyHash; } catch { return false; }
  }));
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeMonitor + 1);
  monitorProof = { falseMonitor, trueMonitor };
  pass('activated true SOL policy pauses once with frozen hash despite concurrent draft edit', { monitorId: trueMonitor.id, runId: trueMonitor.lastRunId, hash: trueMonitor.latestEvidence.transaction.hash });
  // Fault injection: restore an actual WebSocket/persisted reporting snapshot
  // emitted by this backend before the mined receipt was recorded. The existing
  // real-chain transaction is not fabricated, re-sent or replaced.
  const reportingSnapshot = reportingSnapshots.get(confirmed.id);
  assert.ok(reportingSnapshot, 'Expected a real pre-confirmation reporting snapshot');
  await stop(backend);
  const interruptedDb = new Database(env.STATE_DB);
  interruptedDb.query('UPDATE states SET payload=? WHERE id=1').run(JSON.stringify(reportingSnapshot));
  interruptedDb.close();
  const beforeRecovery = await publicClient.getTransactionCount({ address: wallet.account.address });
  await startBackend();
  await call('get_run', { runId: confirmed.id });
  const recovered = (await state()).runs.find(row => row.id === confirmed!.id)!;
  assert.equal(recovered.status, 'confirmed');
  assert.equal(Boolean(recovered.uncertain), false);
  assert.equal(recovered.evidence?.transactionHash, confirmed.evidence!.transactionHash);
  assert.equal(recovered.evidence?.policyHash, confirmed.evidence!.policyHash);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeRecovery);
  const retainedMonitor = (await call('get_monitors', { monitorId: trueMonitor.id })).data.monitors[0];
  assert.equal(retainedMonitor.status, 'completed');
  assert.equal(retainedMonitor.latestEvidence.transaction.hash, trueMonitor.latestEvidence.transaction.hash);
  pass('completed real monitor survives backend restart and never submits again');
  pass('interrupted reporting snapshot reconciles the real mined event without re-submission', { runId: recovered.id, hash: recovered.evidence!.transactionHash, faultInjection: 'restored actual pre-confirmation state emitted during this run' });
  const broadcastSnapshot = monitorBroadcastSnapshots.get(trueMonitor.id);
  assert.ok(broadcastSnapshot, 'Expected the actual durable monitor broadcast barrier to be emitted');
  await stop(backend);
  const monitorDb = new Database(env.STATE_DB);
  monitorDb.query('UPDATE policy_monitors SET status=?,next_check_at=NULL,payload=? WHERE id=?').run('checking', JSON.stringify(broadcastSnapshot), trueMonitor.id);
  monitorDb.close();
  await startBackend();
  const uncertainMonitor = (await call('get_monitors', { monitorId: trueMonitor.id })).data.monitors[0];
  assert.equal(uncertainMonitor.status, 'uncertain');
  const reconciledMonitor = (await call('reconcile_policy', { monitorId: trueMonitor.id, operationId: 'e2e-monitor-reconcile' })).data.monitor;
  assert.equal(reconciledMonitor.status, 'completed', reconciledMonitor.lastError || 'Monitor recovery failed');
  assert.equal(reconciledMonitor.latestEvidence.transaction.hash, trueMonitor.latestEvidence.transaction.hash);
  assert.equal(reconciledMonitor.latestEvidence.policyHash, trueMonitor.spec.policyHash);
  assert.equal(await publicClient.getTransactionCount({ address: wallet.account.address }), beforeRecovery);
  monitorProof = { falseMonitor, trueMonitor, reconciledMonitor };
  pass('uncertain monitor reconciles the actual receiver event without reactivation or re-submission', { monitorId: trueMonitor.id, hash: reconciledMonitor.latestEvidence.transaction.hash, faultInjection: 'restored actual durable pre-submission barrier emitted by this monitor' });
  // Public devnet is intentionally not replaced by a local Solana validator or
  // injected target when its RPC is throttled. The predicate uses live prices.
  const solanaGraph = { nodes: [
    { id: 'sol', kind: 'price', source: { type: 'exchange-trade', pair: 'SOL-USD' } },
    { id: 'btc', kind: 'price', source: { type: 'exchange-trade', pair: 'BTC-USD' } },
    { id: 'sol-low', kind: 'compare', input: 'sol', op: '<', value: 0.0001 },
    { id: 'btc-low', kind: 'compare', input: 'btc', op: '<', value: 0.0001 },
    { id: 'either', kind: 'or', inputs: ['sol-low', 'btc-low'] },
  ], root: 'either', action: { type: 'solana-transfer', network: 'devnet', recipient: '11111111111111111111111111111111', amountLamports: 1 } };
  try {
    const revision = (await state()).workflow.revision;
    await call('compose_graph', { expectedRevision: revision, graph: solanaGraph, operationId: 'e2e-public-solana-false-compose' });
    const frozen = (await state()).workflow.revisions.at(-1)!;
    assert.equal(frozen.target?.kind, 'solana-wallet');
    const target = frozen.target as any;
    assert.equal(target.genesisHash, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    assert.equal(target.network, 'devnet');
    assert.equal(target.vaultDependency, undefined);
    const result = await complete((await call('run_workflow', { expectedRevision: revision + 1, operationId: 'e2e-public-solana-false-run' })).runId);
    assert.equal(result.status, 'no-op');
    assert.equal(result.action, 'solana-transfer');
    assert.equal(result.evidence?.solanaTransfer, undefined);
    assert.equal(result.evidence?.transactionHash, undefined);
    assert.equal(result.observations?.length, 2);
    assert.deepEqual(result.target, frozen.target);
    assert.ok(result.decisions.some(row => row.role === 'root' && row.passed === false));
    publicSolanaPolicy = { status: 'verified', frozenTarget: target, run: result, realSettlement: false };
    try {
      const walletData = await call('get_solana_devnet_wallet');
      assert.equal(walletData.data.address, target.sender);
      assert.equal(walletData.data.balanceLamports, 0);
      publicSolanaPolicy.wallet = walletData.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Solana.*unavailable|HTTP 429|rate.limit|RPC.*timeout|fetch.*timed.out/i.test(message)) throw error;
      publicSolanaPolicy.walletInspection = { status: 'blocked', error: message };
    }
    pass('public Solana devnet target with live SOL/BTC false graph produces no transfer without requiring an EVM vault', { runId: result.id, sender: target.sender, genesisHash: target.genesisHash });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/Solana.*unavailable|HTTP 429|rate.limit|RPC.*timeout|fetch.*timed.out/i.test(detail)) throw error;
    publicSolanaPolicy = { status: 'blocked', error: detail, attemptedAt: new Date().toISOString(), realSettlement: false, note: 'Public devnet RPC did not permit real validation; no target or transaction was fabricated.' };
    console.log('BLOCKED public Solana devnet policy: ' + detail);
  }
  await mkdir(resolve(root, 'demo'), { recursive: true });
  const evidence = { verifiedAt: new Date().toISOString(), passed: true, acceptedProductProof: false, scope: 'historical direct-execution research; current product execution requires Chainlink CRE', semanticApiVersion, mode: 'isolated real local EVM with live Coinbase and mainnet Chainlink sources', testnetBroadcast: false, activeChainMutated: false, activeCanvasMutated: false, temporaryWorkspace: folder, rpcUrl, backendUrl: baseUrl, steps, confirmedRun: confirmed, additionalRuns, monitorProof, publicSolanaPolicy };
  await Bun.write(artifactPath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${artifactPath}`);
  const holdSeconds = Number(process.env.ORIGINS_QA_HOLD_SECONDS || 0);
  if (Number.isInteger(holdSeconds) && holdSeconds > 0 && holdSeconds <= 60) {
    console.log(`Keeping isolated services available for ${holdSeconds}s for an independent operator check.`);
    await Bun.sleep(holdSeconds * 1000);
  }
} catch (error) {
  await Bun.write(resolve(folder, 'failure.json'), JSON.stringify({ passed: false, steps, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  console.error(`Failure artifacts: ${folder}`);
  throw error;
} finally {
  socket?.close();
  await mcp?.close();
  for (const child of children.reverse()) await stop(child);
}
