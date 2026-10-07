# Woga

**Speak. Observe. Execute.** A treasury policy canvas for TOKEN2049 Origins, with Chainlink CRE as its execution authority. A real Codex operator composes typed policies through MCP; the canvas retains source identities, frozen revisions, observations and verified receipts.

## Run

```sh
bun install
bun run dev
```

Open [the observatory](http://127.0.0.1:5173). Bun and a signed-in Codex CLI are required for conversational commands. `bun run dev` starts the backend and canvas in CRE mode; it does not start a standalone chain signer. To prepare speech recognition, run `bun run voice:setup` (pinned local whisper.cpp and verified base.en model; requires the build tools printed by the installer).

Type in the command dock, or select **Mic** to speak. Local transcription sends final text to the same real operator/MCP pipeline. `/` expands the dock; `I` opens proof; `0` fits the graph. Optional browser recognition may use its browser provider when local recognition is unavailable; its privacy status is visible. The timed demo uses preplanned text turns. Stop prevents future cues, and Clear preserves contract state.

For Codex desktop voice, use [operator/](operator/README.md). Browser dictation has its own verified implementation; desktop voice remains a separate integration requiring an actual user-started walkthrough.

## Compose through CRE

Example prompts:

- “Show SOL and ETH prices, BTC's mainnet Chainlink feed, and the grant vault.”
- “Pause the vault if SOL is below $100, or ETH is above $4,000 and BTC's mainnet feed is above $80,000.”
- “Explain the policy and its freshness guards.”
- “Evaluate this revision without broadcasting and inspect its exact inputs.”
- “Watch this policy every 30 seconds.”
- “Stop the active monitor.”

The vocabulary covers exact Coinbase USD markets and configured Chainlink feeds on explicit networks, comparisons, freshness, vault state, AND, OR and NOT. The operator assembles validated data, never arbitrary executable code. Every node must be reachable; equivalent reordered graphs have the same structural hash.

The implemented action is **pause-vault**, delivered by the actual CRE workflow. Execution reads exchange APIs through CRE HTTP capabilities and feed/vault state through CRE EVM capabilities, evaluates the frozen graph, generates a report and submits it through the configured forwarder. Canvas discovery readings are previews; a run archives its own CRE observations. Direct local/testnet signers, standalone Solana transfers and copy-trading are unavailable in the product, including through HTTP/MCP bypass attempts. Unsupported requests do not substitute a different action.

A run freezes its graph, revision, hash and Sepolia receiver. Confirmation requires a successful receipt, the matching run/revision/hash event, and paused state at the receipt block. Failed sources or guards produce an explicit no-op or failure; uncertain submissions remain blocked until read-only reconciliation establishes their outcome.

`run_workflow` evaluates once. `evaluationOnly:true` freezes no-broadcast authority even when the policy passes; evaluations cannot join a broadcast run or reuse its operation ID. An identical operation ID returns the original run; a new completed-run request fetches fresh inputs. Explicit `activate_policy` schedules CRE checks against a frozen revision. Draft edits do not change it. The backend scheduler pauses across restart and stops after settlement. **It is not a deployed DON trigger.** There is no direct-signing fallback when CRE is unavailable.

## CRE setup and real chain proof

Authenticate using `cre/bin/cre login` or `CRE_API_KEY`. Configure the report-v2 Sepolia receiver and a funded Sepolia test wallet for broadcast; keep keys out of source control. The inspector's live readiness check separates CLI authentication, evaluation configuration, broadcast configuration and unverified funding.

A fresh owned receiver and successful **CRE local simulation with actual Sepolia broadcast** are verified:

[Sepolia transaction](https://sepolia.etherscan.io/tx/0xbf74d6505904c5cd08761cfd652faa17c6c84caae03eae7f1fd62b302a2c01a8) · block **11861976** · matching receiver event, frozen policy and historical paused state independently verified through two public RPC providers on October 7, 2026. The vault was subsequently resumed. This is historical chain proof, not current state or deployed DON consensus.

[Fresh CRE evidence](demo/sepolia-evidence-2026-10-07T09-06-03-441Z.json) · [Independent verification](demo/sepolia-current-proof-verification.json) · [CRE-only API/MCP boundary](demo/cre-boundary-verification.json) · [Fresh CRE acceptance](demo/cre-acceptance-verification.json) · [Browser dictation E2E](demo/voice-browser-e2e-verification.json) · [Browser CRE delivery](demo/browser-cre-broadcast-verification.json)

Copy-trading is technically possible through a CRE report receiver that owns the swap assets and enforces budgets, source identity and replay protection. That receiver/workflow is not implemented or publicly verified here, so copy-trading is faded. Existing direct signer modules and local-AMM proof are retained as isolated research, excluded from product tools. [Feasibility review](docs/cre-copytrading-feasibility.md).

## Verification

```sh
bun run check
bun run build
bun test
bun run --cwd cre typecheck
bun run --cwd cre build:wasm
forge test --root contracts -vv
bun run test:boundary
bun run verify:proof
# Requires CRE authentication; no broadcast or private signing key:
bun run test:e2e
```

The accepted E2E harness uses a disposable backend/SQLite and official MCP, evaluates a contradictory condition through the real CRE CLI, checks frozen-monitor behavior and restart persistence, then independently verifies the saved public receipt. A missing CRE login fails honestly. The prior direct local harness requires an explicit research flag and cannot certify CRE execution.

Browser voice proof used synthetic spoken input through real MediaRecorder, local Whisper, Codex and live market discovery; no ambient human microphone or chain action was claimed. [Audio bounds verification](demo/voice-api-validation.json).

`bun run build` serves the production app from [the backend](http://127.0.0.1:4318). Services bind to localhost. Optional private-tailnet sharing is not started automatically.

[Execution contract](docs/execution-contract.md) · [CRE setup](docs/cre-integration.md) · [Environment options](.env.example) · [Operator guidance](operator/AGENTS.md)
