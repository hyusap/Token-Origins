# Execution contract

Graph version **2** · report version **2** · semantic API **6**.

Sources of truth: `cre/graph.ts`, `cre/spec.ts`, `cre/runner.ts`, `server/engine.ts`, `server/monitor.ts` and `shared/types.ts`. Presentation positions and viewport never affect policy identity or evaluation.

## Policy vocabulary

A policy is `{ nodes, root, action }`. Agents assemble typed data, never generated code or arbitrary source URLs.

| Node | Inputs | Result |
| --- | --- | --- |
| `price` | Exact source identity | USD reading |
| `compare` | Price, `< <= > >=`, USD threshold | Boolean |
| `freshness` | Price, maximum age | Boolean |
| `vault-paused` | Expected state | Boolean |
| `and` / `or` | 2–8 Boolean inputs | Boolean |
| `not` | Boolean input | Boolean |

The sole product action is `pause-vault`, executed through the actual Chainlink CRE workflow. Swaps, simulated sells, copy-trading and direct Solana signing are unavailable through product HTTP/MCP tools. Internal historical schemas retain older actions solely for reading archives and explicit dependency-injected laboratory tests; they do not authorize product execution.

Validation at composition, frozen-request parsing and every execution boundary requires unique IDs, resolvable typed operands, no cycles, a Boolean root, every node reachable, registered feed networks and at most five distinct price sources. Invalid or missing data throws; it never becomes a false reading that NOT could invert.

## Sources, precision and identity

Coinbase exchange sources are exact validated `SYMBOL-USD` pairs. Feed sources bind provider, symbol, explicit network and registered aggregator address. Mainnet and Sepolia feeds are different inputs. No cross-network substitution occurs. Source reads are deduplicated.

USD comparisons use integers at 1e-8 precision. Observations archive original raw values, decimals, provider, network, address, round ID where applicable, observation and fetch timestamps. A source-less vault-state policy has no fabricated price field.

`policyHash(graph)` structurally hashes the policy. Node IDs, declaration order and AND/OR operand order do not alter it; actual source identities, thresholds, operators and actions do. Frozen runs and on-chain events carry this hash.

## Evaluation

Intermediate conditions use node IDs and role `node`. The root is a separate `root` verdict. Mandatory gates have role `guard`: every exchange observation must fit the run's freshness cap (at most 120s), every oracle must be within 26h, and the vault must be active. Future observations beyond the allowed skew fail. Explicit freshness nodes can impose tighter conditions.

A false intermediate branch inside a passing OR or NOT is neutral. The action proceeds only when the root and every mandatory guard pass. `blockedBy` and `noopReason` identify the actual stopping gate.

## Frozen execution and receiver

An `ExecutionSpecification` contains version2, runId, revision, validated graph, matching policyHash, maximum exchange age and optional broadcast flag. The engine freezes target receiver/chain alongside it. Draft edits cannot change a running or monitored revision.

Report v2:

```text
abi.encode(version=2, target, chainId, keccak256(runId), revision,
           policyHash, action=1, decidedAt)
```

The vault requires its immutable trusted forwarder, matching report/domain/action, valid non-zero identities and decision timestamp. It suppresses run replay and emits `SpendingPaused(runHash, revision, policyHash, decidedAt)`. It does not re-evaluate market conditions.

A confirmed chain pause requires successful receipt, a matching receiver event and paused state at the receipt block. Later resume transactions do not invalidate historical proof. Product execution always uses the CRE CLI and its HTTP/EVM/report/write capabilities. There is no direct local/testnet fallback. CRE simulation with public broadcast is distinguished from deployed DON execution; old direct-mode evidence remains labelled historical research. See [CRE integration](cre-integration.md).

## Operations and monitoring

| Operation | Meaning |
| --- | --- |
| Compose | Revision-checked validated draft edit |
| Run | Freeze a revision and evaluate fresh live inputs once |
| Retry | Same operationId returns the original run |
| Join | New operation during that revision's in-flight run joins it |
| Fresh run | New operation after completion fetches new observations |
| Evaluate only | `run_workflow` with `evaluationOnly:true` freezes `broadcast:false`; actual CRE reads/evaluation with no report or write |
| Activate | Explicitly freeze and watch a policy every 15–3,600s |
| Deactivate | Stop future checks for a specific monitor |
| Reconcile | Read-only recovery of an uncertain monitor |

Monitors archive their checks, target and graph in SQLite. A CRE dry run determines whether a fresh CRE write attempt is needed; the write attempt fetches its own inputs through CRE again. Both evidence mode and frozen executor must identify CRE on Sepolia. Archived direct/local/Solana jobs cannot activate or invoke an executor. Monitors stop after confirmation, use bounded failure backoff, and do not automatically resume after restart. Draft changes do not alter active monitors. Clear/reset refuses while monitors or writes require attention.

Run lifecycle is queued → fetching → evaluating → reporting → confirmed/no-op/failed. Interrupted writes become uncertain. The engine persists a submitted hash before waiting for its receipt. Reconciliation correlates the original target, run, revision and hash; it never blindly resubmits. A false processed-run flag alone is insufficient evidence of safe absence.

## UI, persistence and compatibility

The draft renders `workflow.graph`; a selected run renders `run.snapshot.graph`. Archived decisions and observations belong to that frozen run. Historical fixture/simulated evidence remains labelled honestly when loading old records, but runtime cannot create it.

SQLite stores canvas and run snapshots transactionally, operation deduplication and monitor history. Legacy drafts migrate to their equivalent graphs without manufacturing evidence for older runs. Sequence/revision IDs remain monotonic across reset and undo.

Health and capability APIs expose graph/report/API versions, supported actions/sources and semantic fingerprints. MCP refuses incompatible semantic operations. Text-only MCP clients receive the same compact complete state as structured-content clients.

Product startup does not start Anvil or reset/resume contracts. Historical local-chain snapshots remain intact for research. Rehearsal reset only clears eligible canvas state; it preserves the on-chain vault. `/api/cre/capabilities` separately reports authentication, receiver configuration, signing-key presence and unverified funding without exposing account details.

## Evidence

- 242 application/CRE tests across 30 files, including explicit research unit adapters. Receiver tests cover 10 product cases; 2 test-token cases are historical research.
- [CRE-only HTTP/MCP boundary](../demo/cre-boundary-verification.json): unavailable utilities cannot be listed or invoked and incompatible graphs leave policy state unchanged.
- [Independent Sepolia verification](../demo/sepolia-independent-proof-verification.json), [actual CRE simulation broadcast transaction](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec). Historical settlement does not independently establish DON execution.
- [Actual browser dictation pipeline](../demo/voice-browser-e2e-verification.json): synthetic speech→MediaRecorder→local Whisper→Codex/MCP→live market discovery, with no chain action.

`bun run test:e2e` uses actual CRE authentication for a no-write frozen-policy monitor/restart check and independently verifies public proof. A missing CLI login blocks that probe honestly. Old local-EVM/Solana/AMM artifacts are research and cannot certify accepted CRE-only execution.

Codex desktop voice, deployed DON triggers/authorization and additional CRE receiver actions are unproven milestones.
