# Sotto

**Speak. Observe. Execute.** A voice-native treasury observatory for TOKEN2049 Origins, built around Codex semantic MCP tools and a bounded Chainlink CRE workflow.

The canvas keeps observations, their sources, conversational focus, policy revisions, and immutable execution evidence together. This implementation includes a real Codex-agent rehearsal and real local contract execution. It uses the Blockchain at Berkeley design system with an original Sotto wordmark.

## Open the demo

For an operator chat, open [`operator/`](operator/README.md) as the primary Codex project folder. Its `AGENTS.md` and `.codex/config.toml` make new chats Sotto operators with the semantic MCP attached. Coding chats belong in the parent project. The rehearsal agents also start in `operator/` with that same prompt.

```sh
bun install
bun run dev
```

Open http://127.0.0.1:5173. A production build is also served by the backend at http://127.0.0.1:4318 after `bun run build`. The supervisor starts an isolated localhost Anvil chain, deploys the grant vault if needed, and starts the backend and Vite. Prerequisites: Bun, Foundry (`forge`, `anvil`), and an authenticated Codex CLI. No private wallet or testnet credentials are needed for the local demo.

- **Space** starts the complete timed rehearsal from an empty canvas. Each prompt is interpreted by a real Codex CLI agent, which calls semantic MCP tools. A new rehearsal resumes only this project's local vault.
- **/** opens a text transcript prompt; **Enter** sends it to Codex.
- **I** shows provenance and the semantic tool trace.
- **M** or **Mic** enables a local microphone waveform after browser permission. Audio is analysed in memory, with no recording or upload; this does not transcribe commands.
- **V** narrates planned prompts and final responses with optional browser speech synthesis. The waveform responds only to the microphone.
- **Clear** archives the current canvas; **Undo clear** restores its policy and execution evidence while the canvas is still empty. Neither changes the deployed contract.
- **+ / −** zoom, arrow keys pan, and **0** fits the graph. Trackpad pan and pinch also work.
- **Escape** stops microphone capture, future rehearsal prompts, and narration. Submitted actions and blockchain transactions continue.

The canvas uses React Flow custom nodes, port-connected edges, and its real viewport. Discovery, focus, source navigation, pinning, composition, revision, undo, execution, and inspection remain semantic operations; objects are not manually rewired. Semantic focus and navigation also move the viewport.

The 13-cue rehearsal takes around six minutes with the measured CLI/model setup. Prompts have minimum scheduled offsets and defer when a previous turn is still working. To trigger each prompt manually in the terminal, run `bun run rehearse`; for automatic timing, run `bun run demo`.

The app opens directly on the full-screen graph. A compact microphone meter sits beside the mic control in the header and appears only while capture is live. The completion caption updates after the user's task finishes; price timestamps and exchange provenance stay in the cards and inspector. Permission denial, cancellation, and device disconnection are handled. Live microphone capture was verified in the Codex in-app browser with 2,048-sample frames and changing measured amplitude; spoken command transcription remains separate.

Price discovery accepts exact Coinbase USD asset names, symbols, and qualified market IDs, and keeps each asset as a separate observation. Omitted tokens defaults to ETH; the grant-vault spending policy always uses ETH/USD. Restart `bun run server` after backend changes: a newly started MCP bridge checks semantic API compatibility before discovery and rejects older backends that would discard token arguments. `/api/health` reports the running process ID, start time, semantic API version, and a startup fingerprint of the semantic sources.

## What actually works

Two complete 13-cue takes each made **31 real MCP calls**. They discovered live timestamped Coinbase ETH/USD data and a deployed local vault, composed and revised the rule, recovered from an ambiguous reference, executed a false condition without a transaction, then delivered a pause report on the local EVM. The app required all three proofs before confirmation: a successful mined receipt, the matching receiver event, and a fresh `paused()` contract read. Later already-paused runs were no-ops. Additional real-agent probes verified source pinning, undo, old-receipt selection, and execution metadata, bringing the total to **86 actual MCP calls**. A rejected direct run reference in one probe was fixed and successfully retested with the real agent; the original failure remains in the saved evidence.

[Portable execution evidence](demo/evidence-summary.json) · [Full rehearsal evidence](demo/rehearsal-report.json) · [Observed validation](docs/voice-validation.md) · [Final browser checks](demo/browser-validation.json)

The final take's verified pause transaction is `0x02f81a058f1e52a9698aec7635f7001ba8c37ed4036e54d2f357b3501f0b94d0`, block 7 on **Anvil chain 31337**. Both this receipt and the first take's block-5 receipt survived an actual node restart. These are local EVM evidence; Sepolia remains untested.

## Architecture

```text
Preplanned transcript / Codex desktop voice (future actual voice test)
    → Codex agent
    → official MCP stdio server
    → Bun semantic backend + SQLite
    → WebSocket → React observatory
    → immutable execution specification
        → local EVM rehearsal runner (default)
        → CRE HTTP-trigger workflow (explicit authenticated mode)
    → receipt + receiver event + fresh contract read → same canvas
```

The backend has optimistic revision checks and persistent operation deduplication. Executions freeze a revision and inputs; delayed tools cannot overwrite a newer draft. A repeated run of the same revision returns its existing run. Errors and no-ops are visible and inspectable.

The CRE implementation is a fixed, allowlisted graph evaluator. The composed graph supplies a specification for Coinbase price fetch → EVM vault read → threshold + freshness + active-vault guards → AND → pause report. It does not generate arbitrary code or claim to be a native CRE graph feature. In CRE mode, fetches, reads, decisions, and report submission happen inside the CRE workflow.

## Honest boundaries

- **The default runs actual local EVM transactions through an explicitly named rehearsal forwarder.** It does not invoke CRE or demonstrate DON consensus.
- **CRE simulation with a real Sepolia broadcast is proven.** A composed policy (Coinbase ETH trade AND Chainlink mainnet BTC feed) was evaluated inside the CRE workflow and paused the Sepolia vault in [`0x82e480e1…`](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec) (block 11861492). The receiver event carries the same policy hash as the frozen graph. The same run also recorded a false condition with no write, a duplicate with no second pause, and a simulated sell refused before any read or write. Evidence: [`demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json`](demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json); re-check it with `bun run verify:evidence demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json`. This is the CRE CLI simulator broadcasting through Chainlink's MockForwarder, **not** a deployed DON workflow.
- Report v2 is also verified on real local Anvil by `tests/anvil-integration.test.ts`. The older takes above used report v1 (ETH-only threshold).
- **Built-in desktop voice remains untested.** Preplanned voice prompts use the real Codex/MCP agent. Browser microphone capture supplies only the requested amplitude display; speech recognition and native Codex voice are separate integrations.
- The draft revision in the observed take arrived after the fast local run finished. Snapshot immutability was verified; audio interruption during an in-flight transaction was not.
- Measured CLI agent turn duration was 17.1–35.3 seconds, median 20.6 seconds. These are not voice latency figures. First-render acknowledgement handling was corrected after that take; its original render numbers are not claimed as reliable performance.

[CRE setup and implementation](docs/cre-integration.md) · [Future voice feasibility test and exact MCP setup](docs/voice-rehearsal.md)

## Validation

```sh
bun run check
bun run build
forge build --root contracts && bun test tests   # includes a real-Anvil integration test when Foundry is installed
bun run --cwd cre typecheck
bun run --cwd cre test
bun run --cwd cre build:wasm
forge test --root contracts -vv
```

Policies execute through one decision path. Fixture, local EVM and CRE runs all validate the same graph, check its structural policy hash, read only the sources it names, and apply the same mandatory guards; see [the execution contract](docs/execution-contract.md). Backend tests cover revision conflicts, operation retries, immutable runs, fresh runs, migration of pre-graph saves, and restart recovery that never resubmits blindly. CRE tests run the real handler under the official capability mocks, including zero writes for simulated sells and refusal of unsupported networks. Solidity tests cover report v2 authorization, target/chain/action binding, expiry, replay and paused spending. `tests/anvil-integration.test.ts` deploys the vault on a throwaway Anvil node and proves false → verified composed pause → no duplicate → sell never writes, then re-verifies the evidence from chain data.

`bun run scripts/verify-local.ts` runs the same proof with live prices on the dev chain and resumes the vault afterward. Run it outside an active demo. The development key is the public Anvil account and is explicitly rejected outside localhost chain 31337. For Sepolia, see [CRE setup](docs/cre-integration.md#sepolia-deploy-and-prove).

UI and voice work can build against `fixtures/states/*.json`: full canvas states produced by the real engine for a legacy rule, nested AND/OR/NOT, a false root with a true branch, a passing OR with a false branch, a guard-blocked root, an unsupported source, a simulated sell, a failed write, and a verified pause. Regenerate them with `bun run scripts/generate-fixtures.ts`.

## Files

- `src/` — observatory and brand tokens
- `server/` — semantic state engine, sources, SQLite, HTTP and WebSocket
- `scripts/mcp.ts` — official MCP SDK stdio server
- `scripts/agent.ts` — real Codex CLI bridge, traces and timed cues
- `demo/script.json` — filming transcript and minimum cue offsets
- `cre/graph.ts` — policy graph, source registry, policy hash, shared evaluator, report v2
- `cre/runner.ts` — fixture / local EVM / CRE execution paths and chain verification
- `cre/workflow/handler.ts` — the CRE workflow
- `contracts/src/GrantVault.sol` — receiver-enabled grant vault (report v2)
- `scripts/deploy-sepolia.ts`, `scripts/prove-sepolia.ts`, `scripts/verify-evidence.ts` — Sepolia deploy, proof and independent verification
- `fixtures/states/` — reference UI/API states; `docs/execution-contract.md` — the shared contract
- `.codex/config.toml` — project-scoped Sotto MCP connection

The public frontend and backend bind only to localhost. Live broadcasts use an explicitly selected CRE mode and fresh configuration; the local forwarder is not a production Chainlink forwarder.

Local chain persistence: new nodes started by `bun run dev` load/save `.data/anvil-state.json`, checkpoint every five seconds, and preserve block/transaction/history data. Stop the supervisor gracefully to allow its owned node to finish saving. An already-running node is reused; to checkpoint it without stopping or changing it, run `bun run scripts/snapshot-local.ts` after the rehearsal finishes. Keep `.data/` and `contracts/deployment.local.json` together when preserving a demo.

`bun run scripts/verify-local-persistence.ts` selects a confirmed local pause transaction from the current API or saved rehearsal evidence, verifies restoration on a temporary node at port 8546, and stops only that node. An optional `ORIGINS_VERIFY_TX_HASH` accepts a public transaction hash. The check validates the correlated vault event, successful receipt, matching logs, transaction lookup, current balance/state, and paused state at the selected receipt block. Run a true policy version first on a fresh local chain. Dynamic evidence is saved in `demo/dynamic-persistence-verification.json`; the original process replacement proof remains in `demo/chain-persistence-report.json`. The live chain at 8545 is unchanged. See [Foundry state management](https://www.getfoundry.sh/anvil/state-management) for the snapshot mechanism.

## Token price discovery

`discover_objects` accepts `tokens`, for example:

```json
{"objects":["price","vault"],"tokens":["Ethereum","Solana","BTC"],"operationId":"discover-markets-1"}
```

Omitting `tokens` preserves ETH discovery. Exact names, symbols, and identifiers such as `coinbase:SOL-USD` resolve against Coinbase Exchange’s online USD market catalog (cached for five minutes). Each token retains its own canvas card, exchange product identity, source object, trade history, and source/fetch timestamps. Refreshing a token refreshes that market. Ambiguous names require a qualified identifier; unknown names, unsupported contract addresses, missing USD markets, and source failures produce errors rather than substitute prices. Market coverage is bounded by Coinbase listings, not every token on every chain. ETH retains its Kraken fallback. Small token prices retain meaningful decimal precision.

The grant-vault policy and CRE runner remain explicitly **ETH/USD**. Additional discovered markets are observations; SOL cannot silently replace the ETH trigger. Discover ETH and the vault before composing that rule.

The keyboard fallback recognizes “Show me Solana’s price” and “Show prices for ETH and SOL and our grant vault.” Voice/agent clients should use the structured `tokens` argument.

To activate this change on an existing demo: integrate these changes into the checkout used by its backend and MCP launcher, rebuild with `bun run build`, restart only the backend with its existing `STATE_DB`, deployment, and execution environment, then reload/reconnect the Sotto MCP so its tool schema exposes `tokens` (and reconnect voice if that session caches the old tools). Keep Anvil running and preserve the existing canvas database. Code/schema changes cannot update a backend already running the old code; a safe restart window is required. Do not run the demo/rehearsal reset commands to activate pricing.

For a separate preview, use `PORT=4319 STATE_DB=.data/token-preview.sqlite bun run server` in this worktree and point a separate MCP launcher at it with `ORIGINS_BACKEND_URL=http://127.0.0.1:4319 bun run mcp`. This creates a separate canvas; its vault defaults to an explicit fixture unless a deployment is configured. It does not replace the active demo.
