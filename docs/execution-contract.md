# Execution contract (Phase 0)

Owner: Shivam · Reviewer: Ayush · Graph version 2 · Report version 2 · Semantic API 3

This is what "the displayed graph, the spoken sentence, the frozen definition and the on-chain action mean the same thing" means in code. The source of truth is `cre/graph.ts` (policy, identity, evaluation, report), `cre/spec.ts` (frozen request), `cre/runner.ts` (execution paths) and `shared/types.ts` (what the UI reads). Representative full states live in `fixtures/states/`.

## 1. Policy graph

A policy is `{ nodes, root, action }` drawn from a fixed vocabulary. Agents assemble nodes; they never write code, URLs or addresses.

| Node | Fields | Value |
| --- | --- | --- |
| `price` | `source` | a price reading |
| `compare` | `input` (price), `op` `< <= > >=`, `value` USD | boolean |
| `freshness` | `input` (price), `maxAgeSeconds` | boolean |
| `vault-paused` | `equals` | boolean |
| `and` / `or` | `inputs` (2–8 booleans) | boolean |
| `not` | `input` (boolean) | boolean |

Actions: `pause-vault` (real, on-chain) or `sell` (`symbol`, `amount`, venue `mock-venue`): a **simulated** order that never moves assets and runs only in local rehearsal.

Validation (`validateGraph`, run at compose time **and** at every execution boundary, including a direct CRE request): unique ids, resolvable inputs, no cycles, typed operands, boolean root, **every node reachable from the root**, every feed present in the registry for its network, at most **5 distinct sources** (keeps a CRE run within 10 EVM reads).

Layout (positions, viewport) is never part of the graph.

## 2. Source identity

| Source | Identity | Notes |
| --- | --- | --- |
| `{type:"exchange-trade", pair:"ETH-USD"}` | Coinbase ticker URL | the only exchange source |
| `{type:"chainlink-feed", symbol, network}` | network + aggregator address from `FEED_REGISTRY` | `network` defaults to `ethereum-mainnet`; `ethereum-sepolia` has ETH, BTC, LINK, USDC, DAI, SNX |

Key format: `exchange-trade:ETH-USD`, `chainlink-feed:<network>:<SYMBOL>`. A mainnet feed and a Sepolia feed are different inputs; nothing substitutes one for the other. CRE reads a feed on its own network (the project configures RPCs for mainnet and Sepolia), so the aggregator the canvas shows is the one CRE reads. A network without an RPC in `cre/project.yaml` is refused before simulation.

## 3. Units and precision

All values are USD. Comparisons use integers at **1e-8** (Chainlink USD feed precision): `0.99949 < 0.9995` is true. Feed answers are archived as the raw integer plus `decimals: 8`; exchange trades as the exact price string.

## 4. Policy identity

`policyHash(graph)` is a structural keccak hash: node ids and declaration order do not change it, AND/OR operands are order-free, and each feed contributes its network and aggregator address. Every revision, frozen run, report and `SpendingPaused` event carries it. Equivalent reordered graphs have the same hash and the same decision (J1).

## 5. Evaluation and results

`evaluateGraph` returns `conditions[]` keyed by **node id**, each with a `role`:

- `node`: an intermediate result (a false branch inside a passing OR is not a failure)
- `root`: `guard:root`, the policy's own verdict
- `guard`: a mandatory gate appended whether or not the graph expresses it:
  - `guard:source:<key>`: each source within its own age limit (exchange trade ≤ the run's cap, ≤ 120 s; feeds ≤ 26 h, i.e. a missed 24 h heartbeat; > 30 s in the future fails)
  - `guard:vault-active`: for `pause-vault` only, the vault is not already paused

`decision` is `act` only when the root and every guard pass. `blockedBy` names the first failing gate, and `explainNoop` turns it into the spoken reason. A missing or invalid reading **throws** (the run fails); it is never treated as false, which a NOT would invert.

## 6. Frozen request (`ExecutionSpecification` v2)

`{ version: 2, runId, revision, graph, policyHash, maxAgeSeconds (exchange cap 1–120), broadcast? }`. Parsing re-validates the graph and checks the hash (J8).

## 7. Execution paths (one decision path)

| Mode | Inputs | Action | `executionMode` label |
| --- | --- | --- | --- |
| `fixture-rehearsal` | live sources, in-memory vault | in-memory pause, or simulated sell | Local policy rehearsal · fixture vault · no transaction |
| `local-evm-rehearsal` | live sources, Anvil vault | real tx through `LocalRehearsalForwarder` | Local EVM rehearsal · no CRE consensus |
| `cre-local-simulation` | DON capabilities (HTTP consensus, EVM reads) | `writeReport` to Sepolia via CRE MockForwarder | CRE local simulation · Sepolia broadcast |

All three call `evaluateGraph` with the same guards. CRE refuses `sell` before any read or write (J3), and refuses a vault without `reportVersion() == 2` before submitting.

## 8. Report v2 and receiver

`abi.encode(uint256 version=2, address target, uint256 chainId, bytes32 keccak(runId), uint256 revision, bytes32 policyHash, uint256 action=1, uint256 decidedAt)` (256 bytes).

`GrantVault.onReport` checks the forwarder, version, `target == this`, `chainId == block.chainid`, action, non-zero identity, replay (`processedRuns` makes a duplicate a no-op), and age (`decidedAt` within `maxReportAge`, at most 60 s ahead). It then pauses and emits `SpendingPaused(runId, revision, policyHash, decidedAt)`.

The receiver does **not** re-run the policy. The decision belongs to the workflow that the forwarder authenticates; the emitted hash lets anyone check which graph decided. Binding the receiver to a specific deployed workflow identity (via `metadata`) is the separate deployed-DON milestone.

Confirmation requires all three: a successful receipt, a `SpendingPaused` event from the vault matching run, revision **and** policy hash, and a fresh `paused()` read (J9). Anything less is `failed`.

## 9. Run lifecycle

| Term | Meaning |
| --- | --- |
| ready | a validated draft revision with a policy hash |
| run | `run_workflow`: freeze the current revision and execute once |
| retry | same `operationId`: returns the stored result, never re-executes |
| join | new request while that revision is still executing: returns the in-flight run |
| fresh run | new request after completion: new run id, fresh inputs; the already-paused guard still prevents a second pause |
| test | `broadcast: false`: evaluate with live inputs and stop before any write (records `dryRun`) |
| activate | not implemented; scheduled activation is Phase 2 |

Statuses: `queued → fetching → evaluating → reporting →` `confirmed` | `no-op` | `failed`.

- `confirmed`: a verified pause, a fixture pause (`evidence.fixture`), or a simulated sell (`evidence.simulatedOrder`). The UI must say which; only `evidence.transactionHash` is on-chain.
- `no-op`: `noopReason` says why, from the gate that stopped it.
- `failed`: `error` explains; a write failure is never shown as a false condition.
- `uncertain`: set when a restart interrupted a run. The backend reads `processedRuns`/the event from the chain and settles it as confirmed, no-op, or "safe to run again". New runs are refused until it settles; nothing is resubmitted blindly (J10).

Drafts can change while a run executes; the run's `snapshot` (graph and policy hash) and archived inputs never change (J5).

## 10. What the UI reads (`shared/types.ts`)

- `workflow.graph`, `workflow.policyHash`, `workflow.summary` (the policy sentence from `describeGraph`). `workflow.threshold`/`maxAgeSeconds`/`skipPaused` describe only the legacy two-node shape; derive everything else from the graph.
- `run.snapshot.graph`: the frozen graph to render for a selected run. It is not the draft.
- `run.decisions[]`: `{ nodeId, role, passed, detail, id (= kind) }`.
- `run.observations[]`: every input with `provider`, `network`, `chainId`, `address`, `usd`, `raw`, `roundId`, `observedAt`, `fetchedAt`. Derive the live age from `observedAt`.
- `run.noopReason`, `run.policyHash`, `run.action`, `run.uncertain`, and `run.evidence.{transactionHash, blockNumber, policyHash, simulatedOrder, fixture, verification, explorerUrl}`.
- The `action:pause` canvas object keeps its id; its label and data name the real action (e.g. "Simulated sell of 0.5 BTC").

## 11. Persistence and compatibility

- `server/migrate.ts` (state version 2) gives pre-graph workflows, revisions and restorable sessions their equivalent legacy graph and hash. Historical runs are left exactly as recorded (J6).
- `/api/health` reports `semanticApiVersion: 3`, `graphVersion`, `reportVersion`, supported actions and sources, and a fingerprint of the semantic sources. The MCP bridge refuses graph-changing tools against an older backend.
- The local chain is never replaced automatically. A lagging clock is aligned by mining one block. A vault older than v2 gets a new vault deployed beside it, with the old address kept in `previousDeployments`. `ORIGINS_RESET_LOCAL_CHAIN=1` is the only way to start clean, and even then the old snapshot is kept aside.

## 12. Acceptance coverage

| ID | Where |
| --- | --- |
| J1 | `cre/graph.test.ts`, `tests/execution-contract.test.ts` |
| J2 | `tests/execution-contract.test.ts` (fixture), `tests/anvil-integration.test.ts` (local EVM), `cre/workflow.test.ts` (CRE) |
| J3 | `cre/workflow.test.ts`, `tests/execution-contract.test.ts`, `tests/anvil-integration.test.ts` |
| J4 | `cre/graph.test.ts`, `fixtures/states/nested-and-or-not.json` |
| J5 | `tests/execution-contract.test.ts` |
| J6 | `tests/execution-contract.test.ts` |
| J7 | `cre/workflow.test.ts` |
| J8 | `cre/spec.test.ts`, `cre/workflow.test.ts`, `tests/anvil-integration.test.ts` |
| J9 | `tests/anvil-integration.test.ts` (real local EVM). **Sepolia: run `scripts/prove-sepolia.ts`.** |
| J10 | `tests/execution-contract.test.ts`, `tests/anvil-integration.test.ts` |
| J11 | Ayush: voice path |
