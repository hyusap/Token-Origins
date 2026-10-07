# Sotto TODO — Ayush and Shivam

Baseline: `b19a04b` · Plan created 2026-10-07.
Read the [detailed implementation plan](docs/implementation-plan.md) for code
locations, interfaces, dependencies, and acceptance scenarios J1–J11.

Check items only after their acceptance evidence exists. Shivam's S1–S3 evidence: `cre/*.test.ts`,
`tests/execution-contract.test.ts`, `tests/anvil-integration.test.ts`, `contracts/test/GrantVault.t.sol`. The review's passing
baseline tests do not mean these tasks are finished. No implementation changes
are included in this planning update.

## Shared contract — first handoff

- [ ] **Shivam; Ayush reviews:** agree on versioned graph, source identity, units/precision, and action schema. *(Proposed and implemented: [execution contract](docs/execution-contract.md) §1–4. Awaiting Ayush's review.)*
- [ ] **Shivam; Ayush reviews:** define complete immutable observations, node/root/guard results, and action outcomes. *(Proposed and implemented: contract §5, §9, §10.)*
- [ ] **Shivam; Ayush reviews:** separate retries from fresh runs and define test/run/activate semantics. *(Proposed and implemented: contract §9; activate deferred to Phase 2.)*
- [ ] **Both:** publish representative UI/API fixture states with expected graph and spoken summaries. *(Shivam side done: `fixtures/states/` + `tests/fixtures.test.ts`. Ayush to confirm they cover the UI.)*
- [ ] **Both:** agree on shared-file ownership and merge the contract PR before divergent implementations.

## Shivam — priority execution fixes

- [x] **S1:** prevent simulated sells from reaching CRE `writeReport`; test zero writes (J3).
- [x] **S1:** make fixture, local EVM, and CRE paths evaluate the same validated graph (J2).
- [x] **S1:** eliminate first-comparison/node-order-dependent receiver thresholds (J1).
- [x] **S1:** validate graph structure at every execution boundary, including direct CRE input (J8).
- [x] **S1:** define the new receiver/report contract and reject unsupported old-receiver combinations before submission.
- [x] **S1:** test action-specific guards, authorization, expiry, replay, and target/chain/policy binding.

## Ayush — priority UI fixes

- [ ] **A1:** fix larger graphs being classified as legacy and add a five-node regression test.
- [ ] **A1:** restore simulated-order receipts and completion captions; remove false block/pause claims (J3).
- [ ] **A1:** derive policy/action wording from the actual graph instead of fixed ETH/below/pause copy.
- [ ] **A1:** distinguish root outcome from false intermediate branches; use node IDs for results.
- [ ] **A1:** show mandatory guard failures and accurate no-op explanations.

## Ayush — graph and voice interaction

- [ ] **A2:** render actual graph edges and nested AND/OR/NOT structure (J4).
- [ ] **A2:** support stable node focus, source inspection, and configured-but-unfetched inputs.
- [ ] **A2:** preserve layout/viewport while routing semantic edits through revision-checked tools.
- [ ] **A2:** render source identity and live age from timestamps.
- [ ] **A2:** inspect the selected run's frozen graph and inputs separately from the draft (J5).
- [ ] **A3:** update operator instructions and tool guidance for composed-graph edits.
- [ ] **A3:** validate spoken source/operator/group edits, ambiguity, undo, and old-run inspection (J11).
- [ ] **A3:** preserve completion-first captions and truthful stop/interruption behavior.
- [ ] **A3:** update rehearsal prompts and record the working live voice path with timing evidence.

## Shivam — Chainlink, persistence, and evidence

- [x] **S2:** bind every source to provider/network/address; reject unsupported mode combinations (J7).
- [x] **S2:** validate source identity, value precision, and per-source timestamps/freshness (J8).
- [x] **S2:** fetch only required inputs, deduplicate reads, and bound the plan to CRE quotas.
- [x] **S2:** archive every execution reading/provenance and preserve it through `get_run`/MCP compaction.
- [x] **S2:** correlate receipt, receiver event, and fresh post-state to the intended run/revision/target (J9). *(Proven on Sepolia: [`0x82e480e1…`](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec), verified by `scripts/verify-evidence.ts`.)*
- [x] **S3:** migrate pre-graph workflows/revisions/restorable sessions without fabricating old evidence (J6).
- [x] **S3:** persist deduplication and recover uncertain submitted transactions without blind replay (J10).
- [x] **S3:** version graph semantics and reject incompatible MCP/backend combinations.
- [x] **S3:** remove automatic destructive chain replacement; verify restart persistence (J10).

## Shivam — prove execution onchain

- [x] **S4:** run contract tests and local Anvil integration cases for composed graphs.
- [x] **S4:** confirm CRE access, CLI/SDK setup, Sepolia RPC, funded test signer, and correct simulation forwarder. *(CRE login, funded test signer, Sepolia RPC and MockForwarder `0x15fC…9F88` all used in the recorded run.)*
- [x] **S4:** add a repeatable Sepolia deployment and verification procedure. *(`bun run deploy:sepolia`, `bun run prove:sepolia`, `bun run verify:evidence`.)*
- [x] **S4:** record actual CRE simulation + Sepolia broadcast: false, true, duplicate, and failure cases. *(`demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json`: false (no write), true (pause [`0x82e480e1…`](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec)), duplicate (no second pause), sell (refused before any read/write).)*
- [x] **S4:** publish portable receipt/event/post-state evidence that Ayush can inspect in the canvas. *(`demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json` + `contracts/deployment.sepolia.json`; anyone can re-check with `bun run verify:evidence demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json`.)*
- [ ] **Separate deployed-DON milestone:** obtain deployment access, configure authenticated triggers and production receiver binding, deploy/activate, and record actual deployed execution.

## Shivam — Solana treasury (Best use of Solana)

- [x] **SOL1:** `sotto_vault` Anchor program: holds SOL, `pay_grant` refused while paused, forwarder-only `on_report` bound to vault/version/action/age, policy-hash event. *(Local validator: `tests/solana-integration.test.ts`.)*
- [x] **SOL2:** CRE workflow writes the same decision to Solana via `SolanaClient.writeReport`; runner verifies tx, event and vault state. *(`cre/workflow.test.ts`, `tests/execution-contract.test.ts`.)*
- [x] **SOL3:** deploy to devnet and record the multichain proof. *(Program `8g87…hqYD`, vault `7593…XWtE`; CRE pause [tx](https://explorer.solana.com/tx/39R7rvrjVS4etn7wmMXsMge6jpc4JRwnekpVsUmK6kMjQTVovoXeAY2i4Df3NJnmbZ8iWxGxNNmK4VaqPF3PiUHM?cluster=devnet); `demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json` verified 18/18.)*
- [ ] **Ayush:** render `run.evidence.solana` (signature, explorer link, vault) and a Solana vault card.

## Joint integration gate — before adding features

- [ ] **Both:** pass J1–J11 from the detailed plan; keep mocked and live evidence distinct.
- [ ] **Both:** pass application/CRE tests, both typechecks, frontend/WASM builds, and Solidity tests.
- [ ] **Both:** confirm old evidence survives upgrades, undo/restore, and restart.
- [ ] **Both:** reconcile README, operator, voice, and CRE documentation with verified behavior.

## Next useful composition increment — after the integration gate

- [ ] **Shivam:** add typed arithmetic/constants and native/ERC-20 balance reads.
- [ ] **Ayush:** support spoken calculation edits and render treasury valuation graphs.
- [ ] **Shivam:** add one notification action with durable idempotency.
- [ ] **Ayush:** add notification configuration and truthful delivery evidence.
- [ ] **Shivam:** add scheduled checks, activated revisions, fresh run IDs, cooldown/rearm state.
- [ ] **Ayush:** add test/run/activate/pause interactions and distinguish drafts from active versions.
- [ ] **Shivam:** scope drafts, revisions, runs, and activation by policy ID.
- [ ] **Ayush:** add policy selection and voice disambiguation between independent policies.
- [ ] **Both:** verify valuation, notification retry/cooldown, scheduled execution, and two-policy isolation end to end.
