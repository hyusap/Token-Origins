# Woga implementation plan: Ayush and Shivam

Created 2026-10-07. Baseline: `b19a04b`, including feature commit `cc345a2`.
Execution tracker: [root TODO checklist](../TODO.md).

## Outcome and scope

Ship a voice-operated policy canvas where the displayed graph, spoken explanation,
frozen execution definition, and actual onchain action mean the same thing.

Ayush owns frontend, graph interaction, and voice interaction. Shivam owns
Chainlink integration, policy execution, contracts, and proof that the intended
action happened onchain. Voice direction already works according to Ayush;
the work here is extending and validating that interaction for composed graphs,
not rebuilding speech recognition.

First stabilize the existing bounded graph and prove it through CRE simulation
with Sepolia broadcast. Then add the smallest useful composition extensions.
A deployed DON workflow is a separate milestone with separate evidence and access
requirements. Local Anvil transactions and Sepolia simulation broadcasts do not
establish deployed DON execution.

## Code audit and baseline

The existing implementation has a genuine graph evaluator with price, comparison,
freshness, vault-state, AND, OR, and NOT nodes. Graphs are versioned and frozen into
runs. The merged application retains both Coinbase discovery and Chainlink feed
cards. These pieces should be extended rather than replaced.

The preceding review ran 61 application tests, 25 CRE tests, both TypeScript
checks, the frontend build, and WASM compilation successfully. Five temporary
probes reproduced bugs not covered by those suites; they were removed after the
review. Solidity tests and public-chain broadcasts were not rerun in that review.
Passing existing suites is a baseline, not completion evidence for this plan.

| Finding | Evidence in current code | Primary owner |
| --- | --- | --- |
| A simulated sell reaches CRE report submission | `cre/workflow/handler.ts` does not dispatch on `graph.action.type` before `writeReport` | Shivam |
| Reordering nodes changes the effective receiver threshold | `compose_graph` in `server/engine.ts` selects the first comparison's value | Shivam |
| Fixture runs ignore composed graphs | Fixture branch of `Engine.execute` still evaluates the scalar threshold | Shivam |
| Saved pre-graph state cannot be edited reliably | `Engine` loads persisted state without migrating missing graphs | Shivam |
| Graphs with more than two nodes render as legacy | `isLegacyPolicy` in `src/main.tsx` returns true for `nodes.length !== 2` | Ayush |
| Merge dropped simulated-order captions and receipts | Feature commit had `simulatedOrder` rendering; merged `src/main.tsx` does not | Ayush |
| Canvas hides nesting and action identity | `src/flow-model.ts` collapses conditions; policy strip/action card remain fixed | Ayush |
| Source identity changes with execution mode | Backend feed registry reads mainnet; CRE resolves symbols using Sepolia addresses | Shivam |
| Oracle execution inputs are not fully archived | Run inputs contain one price and vault, not a provenance-bearing collection of all reads | Shivam |
| Restart can replace the local chain | `scripts/dev.ts` sets aside snapshots with detected drift over 120 seconds | Shivam |

## Ownership and shared-file rules

| Area | Primary owner | Files and responsibilities |
| --- | --- | --- |
| Canvas and interaction | Ayush | `src/main.tsx`, `src/flow-model.ts`, styles; graph structure, focus, edit feedback, run inspection |
| Voice/operator experience | Ayush | `scripts/agent.ts`, `operator/AGENTS.md`, operator setup, captions, manual command interaction, voice documentation |
| Typed policy and execution contract | Shivam; Ayush reviews | `cre/graph.ts`, `cre/spec.ts`, `shared/types.ts`, `server/schemas.ts` |
| Semantic state and persistence | Shivam | `server/engine.ts`, `server/store.ts`, revision handling, migration, run lifecycle |
| Sources and CRE | Shivam | `server/chainlink.ts`, `server/sources.ts`, `cre/runner.ts`, `cre/workflow/*` |
| Contracts and environment | Shivam | `contracts/*`, deployment/verification scripts, `scripts/dev.ts`, chain persistence |
| MCP compatibility | Shivam; Ayush reviews operator behavior | `scripts/mcp*.ts`, `server/runtime.ts`, API capability/version negotiation |
| Integrated evidence | Both | `demo/`, browser/voice traces, execution fixtures, release documentation |

Use separate branches, for example `ayush/graph-voice` and
`shivam/policy-cre-execution`. Shivam merges the shared contract change first.
Ayush can develop against agreed fixture states while execution work proceeds.
Do not have both branches independently redesign `server/engine.ts` or shared
types. Put cross-owner changes in a small reviewed contract PR before adopting
them in feature PRs.

## Phase 0: agree on the interface before parallel implementation

**Owner: Shivam proposes; Ayush reviews.**

1. Define one versioned, serializable policy representation. Preserve node IDs,
   explicit input references, the boolean root, and explicit action identity.
   Keep layout positions separate from execution semantics.
2. Define a source identity containing provider, asset/pair, network and contract
   address where applicable. A mainnet feed and Sepolia feed are different inputs.
   Publish execution-mode support so unsupported combinations fail before running.
3. Define observations with source ID, value, decimals/unit, source timestamp,
   fetch timestamp, and chain/round/block provenance where available. Define
   precision rules; the current cents-only comparison is insufficient for small
   price changes and stablecoin thresholds.
4. Define results with policy/revision identity, immutable inputs, node results
   keyed by node ID, root result, mandatory guard results, action outcome, mode,
   and transaction or simulated-order evidence. Simulated success must remain
   distinguishable from a verified onchain action.
5. Separate request retry identity from execution identity. Retrying a submitted
   run must deduplicate; an explicit later run of the same revision must be able
   to obtain fresh inputs. Preserve the submitted revision during draft edits.
6. Define semantic edits as validated revision changes. Initially replacing a
   complete graph via `compose_graph` is sufficient; targeted node edits must
   ultimately use the same backend validation and revision rules.
7. Add shared fixture states for a legacy rule, nested AND/OR/NOT, a false root
   with a true branch, a guard-blocked true root, an unsupported source, a mock
   sell, a failed write, and a verified pause. These must be full UI/API states,
   not only evaluator inputs.

Acceptance: both owners can explain and implement the same definition of
"ready", "test", "run", "simulated", "confirmed", and "unsupported". A fixture
includes the expected spoken summary and expected graph structure.

## Phase 1A: Ayush — frontend, graph, and voice correctness

### A1. Make existing results truthful

- Fix legacy classification and add a regression test using a five-node graph.
- Render the policy sentence and action label from the actual definition. Remove
  unconditional ETH/below/pause wording from composed-policy surfaces.
- Restore simulated-order receipt and caption handling lost in the merge. A mock
  order must never claim a block, receiver event, asset movement, or paused vault.
- Display the root verdict separately from intermediate results. A false branch
  inside a successful OR is not a failed execution. Use node IDs as result keys;
  multiple comparisons currently share the `threshold` decision ID.
- Show mandatory guard failures explicitly, including receiver compatibility.
  Do not explain a no-op by simply choosing the first false intermediate node.

Files: `src/main.tsx`, `src/display-reply.ts`, caption tests, new graph UI tests.

### A2. Make graph interaction match the executable structure

- Build canvas nodes and connections from the policy's actual input references.
  Preserve nested boolean groups and NOT. Remove the fixed `conditions:and`
  collapse and unconditional `all pass` label for composed graphs.
- Give each rendered node the same stable identity used by semantic focus and
  execution evidence. Render referenced sources even when they have not been
  separately discovered as cards; distinguish configured from fetched inputs.
- Preserve viewport/layout through refreshes and revision updates. Focus, source
  inspection, pan, zoom, and fit must not modify execution semantics.
- Support node selection, inspection, and semantic edits first. If direct
  dragging or connection editing is added, movement only changes layout;
  connections submit validated backend revisions and surface rejected edits.
- Display source network, address, observation time, and freshness consistently.
  Derive relative age from timestamps instead of leaving a fetched age label
  permanently frozen on screen.
- Inspect a selected run using its frozen graph and observations, not the current
  draft. Keep draft and selected execution visually distinguishable.

Files: `src/flow-model.ts`, `src/main.tsx`, layout styles, canvas-session tests.

### A3. Extend the working voice path to composition

- Update operator instructions to use `compose_graph`/`describe_policy` for
  composed rules and preserve unrelated branches during edits.
- Resolve "this" and "that condition" against actual focus. Disambiguate an
  exchange quote from a same-symbol oracle feed and distinguish AND from OR.
- Cover add/remove condition, change operator, swap supported source, change
  grouping, undo, inspect an older run, and revise while a run is pending.
- Show progress while tools run; publish one completion caption after the task.
  Propagate revision conflicts and source/mode incompatibility honestly.
- Validate that stopping speech, narration, or future prompts does not claim to
  cancel a submitted transaction. Browser microphone amplitude and the working
  command-transcription path remain distinct functions.
- Record a live voice session using manually submitted prompts.
  Measure command-to-visible-change separately from microphone capture and
  transaction completion. Record the actual voice setup used.

Files: `operator/AGENTS.md`, `operator/README.md`, `scripts/agent.ts`,
`docs/voice-rehearsal.md`, `docs/voice-validation.md`.

Acceptance: a user can speak a nested rule, see exactly that rule, revise one
branch, and inspect the original execution without a false completion claim.

## Phase 1B: Shivam — consistent execution and onchain correctness

### S1. Close the action and evaluation bugs first

- Dispatch explicitly by action type before any write. Reject mock sells in CRE
  until implemented there, or return explicit simulated evidence with zero chain
  writes. An unsupported action must fail before side effects.
- Route fixture, local EVM, and CRE paths through the same validated graph
  evaluator. Validate graph structure at execution entry points too; parsing the
  Zod object shape alone does not detect cycles or missing references.
- Remove first-comparison-derived receiver behavior. In the short term, reject
  incompatible graphs at validation with a clear reason. Do not manufacture a
  permissive threshold to bypass the old contract's rule.
- Define a report/receiver version for general composed conditions. Bind the
  report to the authorized policy, action, target, chain, revision, expiry, and
  execution identity; decide whether the receiver stores an approved policy hash
  or validates another explicit authorization commitment. Updating this binding
  must be an intentional operation.
- Retain the old scalar report only through an explicit compatibility adapter.
  Contract authorization, freshness, replay handling, and report decoding need
  tests for the new report version.
- Apply action-specific guards. A simulated order should not inherit a mandatory
  grant-vault read or paused-state gate unless the user's graph references it.

Files: `cre/graph.ts`, `cre/spec.ts`, `cre/runner.ts`, `cre/workflow/handler.ts`,
`server/engine.ts`, `contracts/src/GrantVault.sol`, related tests.

### S2. Bind real sources and preserve evidence

- Replace symbol-only execution resolution with explicit source identity; do not
  silently substitute a testnet aggregator for the displayed mainnet one.
- Validate supported networks, configured feed identity, decoded values, and
  timestamps. Define source-specific age limits separately from report expiry.
  Document whether missing/invalid inputs fail the run or have an explicitly
  supported alternative; do not treat unavailable data as false under NOT.
- Fetch only required graph/action inputs, deduplicate sources, and respect CRE
  capability quotas. Disconnected graph nodes should either be rejected or not
  fetched; they must not accidentally determine the receiver threshold.
- Store every execution observation at full supported precision, with provenance,
  alongside node/root/guard results. Preserve this in `get_run` and MCP compaction.
- Verify receipt success, matching receiver event, and a fresh post-state read.
  Correlate evidence to the intended execution/revision/target. Represent a write
  failure separately from a false condition or a simulated result.

Files: `server/chainlink.ts`, `server/sources.ts`, `shared/types.ts`,
`cre/runner.ts`, `cre/workflow/handler.ts`, `scripts/mcp-compact.ts`.

### S3. Migrations, compatibility, and persistence

- Version and migrate saved current workflows, revision history, and restorable
  sessions. Preserve historical execution evidence; use an explicit legacy
  reader where migration would fabricate information not recorded originally.
- Persist run/action deduplication across restarts and define recovery for a
  transaction submitted before the process stopped. Do not blindly resubmit an
  uncertain transaction.
- Version the semantic contract and expose graph/action/source support. Extend
  the existing discovery-only compatibility check to graph-changing operations.
  Include graph/source definitions in the runtime fingerprint as appropriate.
- Replace automatic chain replacement on timestamp drift with a tested recovery
  that preserves state, or a clear stop requiring an explicit reset decision.
  Keep chain snapshots, deployment metadata, and canvas evidence coherent.

Files: `server/store.ts`, `server/engine.ts`, `server/runtime.ts`,
`scripts/mcp-forward.ts`, `scripts/dev.ts`, snapshot/persistence verification scripts.

### S4. Prove the chain path

1. Run local contracts and graph integration cases on Anvil without losing old
   receipt evidence during restart.
2. Confirm CRE account access, CLI/SDK compatibility, Sepolia RPC, a funded test
   signer, and the correct forwarder for simulation. Re-check current official
   documentation; addresses and access requirements in existing docs may age.
3. Add a repeatable Sepolia deployment/verification path. The existing
   `cre/deploy.ts` is explicitly localhost-only and is not a Sepolia deployer.
4. Run the actual CRE CLI workflow with live reads and Sepolia broadcast. Capture
   false/no-write, true/verified-write, duplicate/no-second-action, and failure
   cases. Do not relabel this local simulation as deployed DON execution.
5. For the separate deployed-DON milestone, obtain deploy access, configure
   authorized HTTP triggers, use the production forwarder/identity binding, deploy
   and activate, then trigger and collect independent execution evidence.
   `cre/workflow/main.ts` currently registers an empty HTTP trigger configuration.

Acceptance: portable evidence records chain ID, addresses, policy revision/hash,
execution ID, all inputs, decisions, transaction hash, correlated event, and fresh
post-state. Another developer can independently verify it using the documented
commands. Missing credentials/access remain explicit blockers, not passed items.

## Phase 1C: Solana as a second write target

Solana is a hackathon track, and CRE writes to Solana directly rather than through
a bridge. This is scoped alongside Phase 1B rather than in Phase 2 because it
changes the action and config contracts that S1 is already rewriting; doing it
after would mean editing those interfaces twice.

### Verified against the installed SDK, not assumed

`@chainlink/cre-sdk@1.23.0` is already in `cre/package.json` and already ships
Solana support. **No SDK upgrade is required.** Confirmed by reading the package:

- `SolanaClient` (`ClientCapability`) is exported from the SDK root, with
  `writeReport` plus reads: `getBalance`, `getAccountInfo`, `getSlotHeight`,
  `getTransaction`, `getProgramAccounts`, `getMultipleAccounts`, `getBlock`,
  `getFeeForMessage`, `getSignatureStatuses`, `simulateTX`.
- Helpers in `sdk/utils/capabilities/blockchain/solana/solana-helpers`:
  `solanaAddressToBytes`, `solanaAccountMeta`, `calculateAccountsHash`,
  `encodeForwarderReport`, `encodeBorshVecU32`, `prepareSolanaReportRequest`,
  `SOLANA_DEFAULT_REPORT_ENCODER`.
- Chain selectors are generated: `solana-devnet` (`16423721717087811551`),
  `solana-testnet`, `solana-mainnet`.
- **A Solana contract mock ships in `@chainlink/cre-sdk/test`**, so the handler is
  testable at the same confidence tier as the EVM path, with no credentials.

### How the write actually lands

The workflow Borsh-encodes a payload and wraps it in a `ForwarderReport`
(`[32-byte accountHash][u32-LE payload length][payload]`). `runtime.report()`
signs it with the `solana` encoder (ecdsa + keccak256). The DON submits to the
Keystone Forwarder program, which verifies oracle signatures and CPIs into the
receiver program's `on_report` instruction.

The forwarder expects accounts in a fixed order: index 0 `forwarderState`,
index 1 the `forwarderAuthority` PDA derived from
`["forwarder", forwarderState, receiverProgram]` under the forwarder program ID,
indices 2+ the receiver's own accounts. `calculateAccountsHash` must be computed
over exactly those accounts in that order; the receiver verifies it, so a
mismatch fails on chain rather than in the workflow.

### What this forces open in our code

- `cre/workflow/handler.ts` pins `chainSelector: z.literal('16015286601757825753')`.
  Config becomes a discriminated target (`evm-sepolia` | `solana-devnet`) so one
  workflow can address either family. This overlaps S2's source/network binding
  and J7; do them together.
- `action` in `cre/graph.ts` is chain-agnostic today (`pause-vault`). It must name
  its target chain and program/contract, otherwise a policy composed for Sepolia
  silently means something else on Solana. This overlaps S1's action contract.
- Report encoding forks by family: `encodeAbiParameters` + `evm` encoder for EVM,
  Borsh + `ForwarderReport` + `solana` encoder for Solana. The evaluator stays
  shared; only encoding and submission differ.
- The receiver mirrors `GrantVault` as an Anchor program: `on_report` deserializes
  the Borsh payload, enforces the same run/revision/price/threshold/staleness
  rules, and is idempotent per run ID. **Rust and Anchor are new to this repo.**
- `evaluateGraph`'s `guard:receiver-threshold` encodes an EVM receiver rule
  (`price < threshold`). Either the Solana receiver adopts the same rule or the
  guard becomes target-specific. Decide before writing the program.

### Order of work, cheapest proof first

1. Target-aware config and action schema, with the existing Sepolia path unchanged.
2. Solana branch in the handler using the SDK's Solana contract mock. Proves
   encoding, account layout, and account-hash construction with no credentials
   and no deployment.
3. Anchor receiver with `on_report` plus unit tests against a local validator.
4. Devnet deployment, then a real signed report end to end.

Steps 1–2 are provable in this repo today. Steps 3–4 need a Solana toolchain,
a funded devnet keypair, and CRE credentials, and carry the same honesty rule as
the EVM path: mocked and live evidence are labelled separately, and an untested
path is never described as working.

### Risks worth naming now

- Anchor/Rust is a new toolchain for this team; the receiver is the long pole.
- Account ordering and the account hash are the most likely source of
  hard-to-read on-chain failures. Assert the hash in a unit test before deploying.
- Solana log triggers exist (Anchor `emit_cpi!` via `anchorCPILogTriggerConfig`)
  but are out of scope here; this phase is write-only.
- Doing this does not make the EVM CRE path proven. Both remain unverified for
  live DON execution until credentials exist.

## Phase 2: smallest useful extensions after Phase 1 passes

| Extension | Shivam | Ayush | Acceptance |
| --- | --- | --- | --- |
| Typed arithmetic and balances | Native/ERC-20 balance adapters, constants, field references, add/subtract/multiply/divide, units/precision | Render/read/edit calculation nodes and explain derived values | Vault balance × selected price can be compared against a USD threshold |
| Notifications | One configured webhook/inbox action with durable idempotency | Destination selection, notification evidence, honest delivery status | A true rule emits one logical notification despite retries |
| Scheduled checks | Cron handler, immutable activated revision, durable cooldown/rearm state, fresh execution IDs | Test/run/activate/pause controls and spoken equivalents | Repeated checks work without editing the policy each time |
| Independent policies | Policy collection/IDs, scoped revisions, runs, and activation | Policy selection and explicit voice disambiguation | Editing one policy does not alter another policy's draft or execution |

Start with minute-scale schedules. CRE callbacks are stateless, so cooldowns,
rearming, and transition detection need explicit durable state outside a callback.
Keep deployed activation distinct from local scheduling. Exclude arbitrary code,
real sell/swap execution, loops, cross-chain actions, and historical windows from
this first extension set.

## Joint acceptance scenarios

Each row needs an automated check where feasible and an integrated UI/voice pass.
Mocked and live evidence must be labelled separately.

| ID | Scenario | Required result |
| --- | --- | --- |
| J1 | Reorder node declarations in an equivalent OR graph | Same root and action decision; same semantic policy identity |
| J2 | ETH at $2,500 with a rule ETH > $3,000 | No action in fixture, local EVM, and CRE paths |
| J3 | Simulated sell with passing conditions | Simulated result or explicit unsupported error; zero chain writes; no pause claim |
| J4 | Nested `A AND (B OR NOT C)` | Same structure in stored graph, canvas, spoken summary, and evaluator |
| J5 | Edit one branch while revision N is running | Draft advances; run N's graph and inputs remain immutable |
| J6 | Load/restore a pre-graph saved session | Supported edits work; historical evidence remains unchanged |
| J7 | Mainnet feed requested in an unsupported CRE mode | Rejected before broadcast; no silent network substitution |
| J8 | Missing/stale/future input or invalid graph | Explicit failure/guard result with no unintended action |
| J9 | Valid composed pause through Sepolia CRE simulation | Successful receipt + matching event + fresh paused-state read |
| J10 | Retry, restart, then independently verify a confirmed run | No duplicate action; original evidence remains inspectable |
| J11 | Voice edit, ambiguity, undo, old-run inspection, stop speech | Correct revision/focus/captions; no implied transaction cancellation |
| J12 | Compose a policy targeting Solana, then one targeting Sepolia | Each run encodes for its own family; neither silently retargets the other |
| J13 | Solana write through the SDK contract mock | Correct `ForwarderReport` framing, account order, and account hash; zero live submissions |
| J14 | Account list reordered before hashing | Receiver rejects; failure is explicit and attributed to the account hash |
| J15 | Same run ID replayed to the Anchor receiver | Second delivery is an explicit no-op; original evidence unchanged |

For Phase 2 add: treasury valuation; once-per-cooldown notification; two independent
policies; activated revision unaffected by an unactivated draft edit.

## Suggested PR and handoff order

1. **Shivam:** action-dispatch containment, evaluator parity, and regression tests.
2. **Shivam + Ayush review:** shared schema, evidence contract, source identity,
   sample states, and compatibility/migration plan.
3. **Ayush:** graph renderer, labels, run inspection, and graph interaction against
   sample states. **Shivam in parallel:** receiver, source, persistence, and CRE work.
4. **Ayush:** operator/voice edits against the stable tools. **Shivam:** publish
   live execution evidence and the repeatable Sepolia procedure.
5. **Both:** run J1–J11, integrate, and update README/operator/CRE docs to describe
   the verified behavior. Keep unfinished public deployment explicitly separate.
6. **Both:** implement Phase 2 extensions in the order shown, with a contract PR
   preceding each new frontend capability.

## Validation commands and evidence

```sh
bun test tests
bun run check
bun run build
bun run --cwd cre test
bun run --cwd cre typecheck
bun run --cwd cre build:wasm
forge test --root contracts -vv
```

Add focused regression tests for the review findings rather than relying only on
archived scripted takes. Existing useful files include `tests/backend-graph.test.ts`,
`tests/canvas-session.test.ts`, `tests/agent-caption.test.ts`,
`tests/mcp-discovery-transport.test.ts`, `cre/graph.test.ts`,
`cre/workflow.test.ts`, and `contracts/test/GrantVault.t.sol`.

Use the existing local verification and persistence scripts on an isolated demo
environment; some reset/resume vault state. Store portable new evidence under
`demo/` with revision, environment, and timestamp, without overwriting historical
takes or including credentials. Document which checks were actually run.

## CRE references

These were consulted during planning; Shivam should re-check environment-specific
details before deployment.

- [Workflow model and stateless executions](https://docs.chain.link/cre/overview)
- [Consumer contracts and receiver identity](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)
- [Deployment and access](https://docs.chain.link/cre/guides/operations/deploying-workflows)
- [Service quotas](https://docs.chain.link/cre/service-quotas)
- [The Solana Write capability](https://docs.chain.link/cre/capabilities/solana-write)
- [Writing to Solana (TypeScript)](https://docs.chain.link/cre/guides/workflow/using-solana-client/onchain-write-ts)
- [Generating Solana bindings (TypeScript)](https://docs.chain.link/cre/guides/workflow/using-solana-client/generating-bindings-ts)
- [Solana chain interactions overview](https://docs.chain.link/cre/guides/workflow/using-solana-client/overview-ts)
