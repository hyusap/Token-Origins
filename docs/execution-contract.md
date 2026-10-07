# Execution contract

Owner: Shivam · Reviewer: Ayush · Graph hash domain v2 · Report v3 (v2 still produced for pause-only vaults) · Semantic API 4

This is what "the displayed graph, the spoken sentence, the frozen definition and the on-chain action mean the same thing" means in code. The source of truth is `cre/graph.ts` (policy, identity, units, evaluation, reports), `cre/onchain-reads.ts` (how contract sources are read), `cre/spec.ts` (frozen request), `cre/runner.ts` (execution paths and verification) and `shared/types.ts` (what the UI reads). Representative full states live in `fixtures/states/`.

## 1. Policy graph

A policy is `{ nodes, root, action }` drawn from a fixed vocabulary. Agents assemble nodes; they never write code, URLs or addresses.

| Node | Fields | Value |
| --- | --- | --- |
| `price` | `source` (exchange trade or Chainlink price feed) | a USD price |
| `reading` | `source` (any source in §2) | a number in the source's unit |
| `math` | `op` `-` `/` `*`, `left`, `right` | a number (see §3 for units) |
| `compare` | `input` (any number), `op` `< <= > >=`, `value` in the input's unit | boolean |
| `freshness` | `input` (a `price` or `reading` node), `maxAgeSeconds` | boolean |
| `vault-paused` | `equals` | boolean |
| `time` | `op` `before`/`after`, `at` (ISO time) | boolean, against the decision time |
| `and` / `or` | `inputs` (2–8 distinct booleans) | boolean |
| `not` | `input` (boolean) | boolean |

Actions:

| Action | Fields | Real? | What the vault does |
| --- | --- | --- | --- |
| `pause-vault` | — | yes | pauses spending |
| `sweep` | `fraction` (0–1, whole bps), `pause` (default true) | yes | sends that share of its ETH to the `reserve` fixed at deploy; also pauses if asked; allowed while paused |
| `pay` | `payee` (a registered name such as `grantee`), `amountEth` (≤ 10, whole gwei) | yes | pays a payee the owner registered, ≤ `maxPaymentWei`, at most once per `minPaymentInterval`, never while paused |
| `evacuate` | `destination` (`base-sepolia`), `fraction`, `pause` (default true) | yes | bridges that share of its CCIP-BnM to `reserve` on the destination through Chainlink CCIP, fee paid in ETH |
| `sell` | `symbol`, `amount`, venue `mock-venue` | **simulated** | nothing; local rehearsal only |
| `rebalance` | `from`, `to` (`aave-v3`/`compound-v3`), `asset` USDC, `fraction` | **simulated** | nothing; local rehearsal only |

Validation (`validateGraph`, run at compose time **and** at every execution boundary, including a direct CRE request): unique ids, resolvable inputs, no cycles, typed operands with compatible units, boolean root, **every node reachable from the root**, every source present in its registry, thresholds with at most 8 decimals, at most **5 distinct sources** (a CRE run then needs at most 11 of its 15 EVM reads).

Layout (positions, viewport) is never part of the graph.

## 2. Source identity

| Source | Identity | Unit |
| --- | --- | --- |
| `{type:"exchange-trade", pair:"ETH-USD"}` | Coinbase ticker URL | USD (the only exchange source) |
| `{type:"chainlink-feed", symbol, network}` | network + aggregator from `FEED_REGISTRY` | USD; `network` defaults to `ethereum-mainnet`; Sepolia has ETH, BTC, LINK, USDC, DAI, SNX |
| `{type:"proof-of-reserve", asset:"WBTC"}` | Chainlink PoR aggregator from `POR_REGISTRY` | WBTC |
| `{type:"token-supply", token:"WBTC"}` | ERC-20 `totalSupply()` from `TOKEN_REGISTRY` | WBTC |
| `{type:"lending-rate", protocol:"aave-v3"\|"compound-v3", asset:"USDC"}` | Aave v3 Pool `getReserveData` / Compound v3 Comet `getSupplyRate(getUtilization())` from `LENDING_REGISTRY` | % APR |
| `{type:"vault-balance"}` | the target vault's ETH balance | ETH |

Keys: `exchange-trade:ETH-USD`, `chainlink-feed:<network>:<SYMBOL>`, `proof-of-reserve:<network>:<ASSET>`, `token-supply:<network>:<TOKEN>`, `lending-rate:<network>:<protocol>:<ASSET>`, `vault-balance`. Contract sources are read on their own network through the same call plan in the backend and in CRE (`cre/onchain-reads.ts`). Rates come from the protocol contracts, not a yield API: CRE caps HTTP responses at 250 KB, and a contract read agrees exactly across nodes. `bun run verify:registry` re-checks every address against the chain.

## 3. Units and precision

Every number carries a unit: a USD price of an asset, a USD amount, an amount of an asset, a percentage, or a ratio. `-` needs two values of the same dimension (any two USD prices give USD); `/` gives a ratio and needs the same dimension (reserves ÷ supply, USDC ÷ USDT); `*` multiplies an amount by its own asset's USD price (vault ETH × ETH/USD → USD) or anything by a ratio. Mismatches are refused at composition with the two units named.

Comparisons use integers at **1e-8**: `0.99949 < 0.9995` is true. Thresholds have at most 8 decimals, so the hash and the comparison see the same number. Feed answers are archived as the raw integer; exchange trades as the exact price string; observations carry `value`, `unit` and (USD prices only) `usd`.

## 4. Policy identity

`policyHash(graph, exchangeCap)` is a structural keccak hash: node ids and declaration order do not change it, AND/OR and `*` operands are order-free, and each source contributes its key and contract address. The action's terms are part of it (fraction in bps, payee and gwei, CCIP chain selector). A non-default exchange freshness cap is part of it. New vocabulary is additive: every graph valid before hashes as it did, so recorded Sepolia evidence still verifies (checked in `cre/graph-actions.test.ts`). Every revision, frozen run, report and receiver event carries the hash.

## 5. Evaluation and results

`evaluateGraph` returns `conditions[]` keyed by **node id**, each with a `role`:

- `node`: an intermediate result (a false branch inside a passing OR is not a failure). Details name conditions in words, never node ids.
- `root`: `guard:root`, the policy's own verdict
- `guard`: a mandatory gate appended whether or not the graph expresses it:
  - `guard:source:<key>`: each source within its own age limit (exchange trade ≤ the run's cap, ≤ 120 s; price and PoR feeds ≤ 26 h; contract state read during the run ≤ 300 s; > 30 s in the future fails)
  - `guard:vault-active`: `pause-vault` only if not already paused; `pay` only while spending is active
  - `guard:vault-funds`: `sweep` needs ETH in the vault; `pay` needs at least the payment
  - `guard:vault-tokens`: `evacuate` needs CCIP-BnM in the vault

`decision` is `act` only when the root and every guard pass. `blockedBy` names the first failing gate and `explainNoop` turns it into the spoken reason. A missing or invalid reading, or a division by zero, **throws** (the run fails); it is never treated as false, which a NOT would invert.

CRE reports are sent with a 2,000,000 gas limit (`ORIGINS_CRE_GAS_LIMIT`); a CCIP evacuation uses about 350k.

## 6. Frozen request (`ExecutionSpecification` v2)

`{ version: 2, runId, revision, graph, policyHash, maxAgeSeconds (exchange cap 1–120), broadcast? }`. Parsing re-validates the graph and checks the hash (J8).

## 7. Execution paths (one decision path)

| Mode | Inputs | Action | `executionMode` label |
| --- | --- | --- | --- |
| `fixture-rehearsal` | live sources, in-memory vault and treasury balances | in-memory pause/sweep/pay/evacuate, or a simulated order | Local policy rehearsal · fixture vault · no transaction |
| `local-evm-rehearsal` | live sources, Anvil vault | real tx through `LocalRehearsalForwarder`; evacuations go to a stand-in router (`LocalCcipRouter`, not CCIP) | Local EVM rehearsal · no CRE consensus |
| `cre-local-simulation` | DON capabilities (HTTP consensus, EVM reads on mainnet and Sepolia) | `writeReport` to Sepolia via CRE MockForwarder, and to Solana devnet via CRE's Solana forwarder | CRE local simulation · Sepolia broadcast |

All three call `evaluateGraph` with the same guards. CRE refuses `sell` and `rebalance` before any read or write (J3). A vault that cannot take the action (§8) is refused before any other read.

The CRE workflow has two triggers: index 0 is HTTP (one execution of the request), index 1 is a cron trigger that evaluates the standing policy in its config (§9).

## 8. Reports and receivers

**v3** (GrantVault v3): `abi.encode(uint256 version=3, address target, uint256 chainId, bytes32 keccak(runId), uint256 revision, bytes32 policyHash, uint256 action, uint256 decidedAt, uint256 flags, bytes32 payeeId, uint256 amount, uint64 destinationChainSelector)` (384 bytes). `action` 1 pause, 2 sweep, 3 pay, 4 evacuate; `flags` bit 0 also pauses (sweep and evacuate only); `amount` is bps for sweep/evacuate and wei for pay; `payeeId = keccak256(name)`.

**v2** (the pause-only vault deployed on Sepolia before v3): the first eight fields, `action = 1`. The runner reads `reportVersion()` and sends v2 to a v2 vault for a pause; any other action is refused before submission with the redeploy instruction.

`GrantVault.onReport` checks the forwarder, length, version, `target == this`, `chainId == block.chainid`, action and flags, non-zero identity, replay (`processedRuns` makes a duplicate a no-op) and age. Every movement is bounded at deploy: the reserve and CCIP destination are immutable, sweeps are capped by `maxSweepBps`, payments go only to owner-registered payees within `maxPaymentWei` and `minPaymentInterval`. The worst a misbehaving workflow can do is move funds to the owner's reserve or pay a registered payee within its cap. Events: `SpendingPaused`, `ReserveSwept`, `GrantStreamed`, `TreasuryEvacuated` (with the CCIP message ID), each repeating run, revision and policy hash.

The receiver does **not** re-run the policy. The decision belongs to the workflow that the forwarder authenticates; the emitted hash lets anyone check which graph decided. Binding the receiver to a specific deployed workflow identity (via `metadata`) is the separate deployed-DON milestone.

Confirmation requires a successful receipt, the receiver having recorded the run (`processedRuns`), the action's own event matching run, revision **and** policy hash (`effectFailures` in `cre/runner.ts`), and, when the action pauses, a fresh `paused()` read (J9). Anything less is `failed`.

**Solana** (`sotto_vault`): v2 `PauseReport` (114 bytes) is accepted by every program version; v3 `ActionReport` (117 bytes: v2's fields, `flags: u8`, `bps: u16`) adds a sweep of the vault's SOL to the reserve the owner set with `configure_reserve` (PDA `["treasury", vault]`). For a sweep, CRE appends [treasury config, reserve] to the hashed account list. Pause → Solana pauses; sweep → Solana sweeps when its reserve is configured (otherwise pauses if asked); pay and evacuate leave Solana unchanged and say so (`evidence.solanaSkipped`).

## 9. Run lifecycle

| Term | Meaning |
| --- | --- |
| ready | a validated draft revision with a policy hash |
| run | `run_workflow`: freeze the current revision and execute once |
| retry | same `operationId`: returns the stored result and the run's current status, never re-executes |
| join | new request while that revision is still executing: returns the in-flight run |
| fresh run | new request after completion: new run id, fresh inputs; the guards still apply |
| test | `broadcast: false`: evaluate with live inputs and stop before any write (records `dryRun`) |
| watch | `watch_policy`: re-check one frozen revision every `everySeconds` (≥ 30, CRE's fastest cron) up to `maxChecks`, stopping after it acts unless `stopOnAction` is false, after 3 failures in a row, on `stop_watching`, on clear, or on a restart. Each check is a fresh run with `trigger: "watch"`; in CRE mode it runs through the workflow's cron trigger. Quiet checks are not said. |

Statuses: `queued → fetching → evaluating → reporting →` `confirmed` | `no-op` | `failed`.

- `confirmed`: a verified on-chain action (`evidence.transactionHash` + `evidence.effects`), a fixture action (`evidence.fixture` + `fixtureEffects`), or a simulated order (`simulatedOrder`, `simulatedRebalance`). The UI must say which; only `evidence.transactionHash` is on-chain.
- `no-op`: `noopReason` says why, from the gate that stopped it.
- `failed`: `error` explains; a write failure is never shown as a false condition.
- `uncertain`: set when a restart interrupted a run. The backend reads `processedRuns` and the receiver's events from the chain and settles it as confirmed, no-op, or "safe to run again". New runs and watches are refused until it settles; nothing is resubmitted blindly (J10).

Drafts can change while a run or watch executes; the run's `snapshot` (graph and policy hash) and archived inputs never change (J5).

## 10. What the UI reads (`shared/types.ts`)

- `workflow.graph`, `workflow.policyHash`, `workflow.summary` (the policy sentence from `describeGraph`; `src/policy-language.ts` re-exports the engine's narration). `workflow.threshold`/`maxAgeSeconds`/`skipPaused` describe only the legacy two-node shape.
- `run.snapshot.graph`: the frozen graph to render for a selected run. It is not the draft.
- `run.decisions[]`: `{ nodeId, role, passed, detail, id (= kind) }`.
- `run.observations[]`: every input with `provider`, `unit`, `value`, `network`, `chainId`, `address`, `raw`, `roundId`, `observedAt`, `fetchedAt` (`usd` for USD prices).
- `run.trigger`/`run.watchCheck`, `run.noopReason`, `run.policyHash`, `run.action`, `run.uncertain`, and `run.evidence.{transactionHash, blockNumber, policyHash, effects, ccipExplorerUrl, solana, solanaSkipped, simulatedOrder, simulatedRebalance, fixture, fixtureEffects, verification, explorerUrl}`.
- `state.watch`: the standing policy (`status`, `revision`, `checks`/`maxChecks`, `everySeconds`, `nextCheckAt`, `lastOutcome`, `stopReason`).
- Canvas objects of kind `reading` (contract readings, `data.display` already formatted); `condition:*` objects carry `data.math` or `data.logic` for computed values and logic nodes. The `action:pause` object keeps its id; its label and data name the real action.

## 11. Recipes

`server/recipes.ts` holds policies modelled on past Chainlink hackathon winners: reserve guardian (SentinelCRE), stablecoin spread shield (FlowVault), yield chaser (YieldCoin, Copil), treasury runway guard (TokenIQ), streaming grant (InControl), parametric cover (Azurance, TAPL), cross-chain evacuation (YieldCoin, Chronomancer). Each only builds a graph from typed parameters; `apply_recipe` then goes through exactly the compose path above. "Inspired by" credits the idea; none of the winners' code is used.

## 12. Persistence and compatibility

- `server/migrate.ts` (state version 2) gives pre-graph workflows, revisions and restorable sessions their equivalent legacy graph and hash. Historical runs are left exactly as recorded (J6). New fields (`watch`, `trigger`, `effects`) are optional.
- `/api/health` reports `semanticApiVersion: 4`, `graphVersion`, `reportVersion`, supported actions and sources, and a fingerprint of the semantic sources. The MCP bridge refuses graph-changing and new tools against an older backend.
- The local chain is never replaced automatically. A vault older than v3 gets a new vault deployed beside it, with the old address kept in `previousDeployments`; the same holds for `contracts/deployment.sepolia.json`.

## 13. Acceptance coverage

| ID | Where |
| --- | --- |
| J1 | `cre/graph.test.ts`, `tests/execution-contract.test.ts` |
| J2 | `tests/execution-contract.test.ts` (fixture), `tests/anvil-integration.test.ts` (local EVM), `cre/workflow.test.ts`, `cre/workflow-actions.test.ts` (CRE) |
| J3 | `cre/workflow.test.ts`, `cre/workflow-actions.test.ts`, `tests/execution-contract.test.ts`, `tests/anvil-integration.test.ts` |
| J4 | `cre/graph.test.ts`, `fixtures/states/nested-and-or-not.json` |
| J5 | `tests/execution-contract.test.ts`, `tests/treasury-actions.test.ts` (watch) |
| J6 | `tests/execution-contract.test.ts` |
| J7 | `cre/workflow.test.ts` |
| J8 | `cre/spec.test.ts`, `cre/workflow.test.ts`, `tests/anvil-integration.test.ts` |
| J9 | `tests/anvil-integration.test.ts` (pause, sweep, pay, evacuate on real local EVM); `contracts/test/GrantVault.t.sol`; Sepolia CRE broadcast [`0x82e480e1…`](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec) |
| J10 | `tests/execution-contract.test.ts`, `tests/anvil-integration.test.ts` |
| J11 | Ayush: voice path |
| Treasury actions | `cre/graph-actions.test.ts`, `cre/workflow-actions.test.ts`, `contracts/test/GrantVault.t.sol`, `tests/anvil-integration.test.ts`, `tests/solana-integration.test.ts`, `tests/solana-upgrade.test.ts`, `tests/treasury-actions.test.ts` |
