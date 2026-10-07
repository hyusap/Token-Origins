# Woga

**Speak. Observe. Execute.** Chainlink CRE for people who don't write code: say what your treasury should do, see it as a graph you can check, and let CRE enforce it on Ethereum and Solana. Built for TOKEN2049 Origins, with Chainlink CRE as its sole execution authority. A real Codex operator composes typed policies through MCP; the canvas retains source identities, frozen revisions, observations and verified receipts.

## Run

```sh
bun install
bun run dev
```

Open [the observatory](http://127.0.0.1:5173). Bun and a signed-in Codex CLI are required for conversational commands. `bun run dev` starts the backend and canvas in CRE mode; it does not start a standalone chain signer. To prepare speech recognition, run `bun run voice:setup` (pinned local whisper.cpp and verified base.en model; requires the build tools printed by the installer).

Type in the command dock, or select **Mic** to speak. Local transcription sends final text to the same real operator/MCP pipeline. `/` expands the dock; `I` opens proof; `0` fits the graph. Optional browser recognition may use its browser provider when local recognition is unavailable; its privacy status is visible. Clear removes canvas state while preserving contract state.

For Codex desktop voice, use [operator/](operator/README.md). Browser dictation has its own verified implementation; desktop voice remains a separate integration requiring an actual user-started walkthrough.

## Compose through CRE

Example prompts:

- “Show SOL and ETH prices, BTC's mainnet Chainlink feed, and the grant vault.”
- “Pause the vault if SOL is below $100, or ETH is above $4,000 and BTC's mainnet feed is above $80,000.”
- “Explain the policy and its freshness guards.”
- “Evaluate this revision without broadcasting and inspect its exact inputs.”
- “Watch this policy every 30 seconds.”
- “Stop the active monitor.”
- “If ETH drops below $2,000 or USDC loses its peg, sweep half the treasury to the reserve and pause.”
- “If WBTC's reserves fall below its supply, pause spending.”
- “Pay the grantee 0.001 ETH every minute while ETH is above $1,000.”
- “If ETH crashes, bridge the treasury's tokens to the reserve on Base and pause.”

The vocabulary covers exact Coinbase USD markets, configured Chainlink feeds on explicit networks, Chainlink Proof of Reserve, ERC-20 supply, Aave v3 and Compound v3 rates and the vault's own balance; math (spread, ratio, product with unit checking), comparisons, freshness, deadlines, vault state, AND, OR and NOT. The operator assembles validated data, never arbitrary executable code. Every node must be reachable; equivalent reordered graphs have the same structural hash.

The implemented actions are **pause**, **sweep** (a share of the vault to the reserve fixed at deploy), **pay** (a payee the owner registered, capped and rate-limited on chain) and **evacuate** (the vault's tokens to the reserve on Base Sepolia through Chainlink CCIP), each delivered by the actual CRE workflow as one report. When a Solana vault is configured, the same CRE decision pauses (or sweeps) it too. Execution reads exchange APIs through CRE HTTP capabilities and feed/vault state through CRE EVM capabilities, evaluates the frozen graph, generates a report and submits it through the configured forwarder. Canvas discovery readings are previews; a run archives its own CRE observations. Direct local/testnet signers, standalone Solana transfers and copy-trading are unavailable in the product, including through HTTP/MCP bypass attempts. Unsupported requests do not substitute a different action.

A run freezes its graph, revision, hash and Sepolia receiver. Confirmation requires a successful receipt, the matching run/revision/hash event (`SpendingPaused`, `ReserveSwept`, `GrantStreamed` or `TreasuryEvacuated`), and the vault state at the receipt block. Failed sources or guards produce an explicit no-op or failure; uncertain submissions remain blocked until read-only reconciliation establishes their outcome.

`run_workflow` evaluates once. `evaluationOnly:true` freezes no-broadcast authority even when the policy passes; evaluations cannot join a broadcast run or reuse its operation ID. An identical operation ID returns the original run; a new completed-run request fetches fresh inputs. Explicit `activate_policy` schedules CRE checks against a frozen pause revision; `watch_policy` runs any vault action through the CRE workflow's own cron trigger. Draft edits do not change it. The backend scheduler pauses across restart and stops after settlement. **It is not a deployed DON trigger.** There is no direct-signing fallback when CRE is unavailable.

## Safety: the vault sets the limits

The agent never holds a key. CRE can only deliver a signed report, and `GrantVault` checks each one against limits its owner fixed at deploy: the reserve and CCIP destination, the payees and their per-payment caps and intervals, the CCIP fee cap and evacuation interval. A pause is always allowed. Worst case, funds go to the owner's own reserve. The vault can lock itself to one CRE workflow identity (`bun run lock:workflow`), and every event repeats the policy hash, so anyone can prove which rule moved which funds.

## CRE setup and real chain proof

Authenticate using `cre/bin/cre login` or `CRE_API_KEY`. Deploy the GrantVault v3 receiver with `bun run deploy:sepolia` and fund a Sepolia test wallet for broadcast; keep keys out of source control. The inspector's live readiness check separates CLI authentication, evaluation configuration, broadcast configuration and unverified funding.

A fresh owned receiver and successful **CRE local simulation with actual Sepolia broadcast** are verified:

[Sepolia transaction](https://sepolia.etherscan.io/tx/0xbf74d6505904c5cd08761cfd652faa17c6c84caae03eae7f1fd62b302a2c01a8) · block **11861976** · matching receiver event, frozen policy and historical paused state independently verified through two public RPC providers on October 7, 2026. The vault was subsequently resumed. This is historical chain proof, not current state or deployed DON consensus.

**Every treasury action, executed through CRE on Sepolia** (CRE CLI simulation broadcasting through Chainlink's forwarder; [evidence](demo/actions-evidence-2026-10-07T12-15-49-819Z.json)):

| Action | What happened | Transaction |
| --- | --- | --- |
| Sweep | 25% of the vault (0.015 ETH) to the reserve | [`0x0c8579…a5e2f3`](https://sepolia.etherscan.io/tx/0x0c8579f63258551c2f9023f3e94872131e45dea8494ff084f24ceac5b6a5e2f3) |
| Pay | 0.001 ETH to a registered grantee, under its cap | [`0xf39ae9…4a998f`](https://sepolia.etherscan.io/tx/0xf39ae9293874951ba94110f21270ff3c705af0478224171d55ef058f544a998f) |
| Evacuate | 2 CCIP-BnM bridged to Base Sepolia, spending paused | [`0x2250c6…85e60f`](https://sepolia.etherscan.io/tx/0x2250c6e994f8691df8582e3e95423341d447468da8b0393c6c3dbe60dd85e60f) · [CCIP message](https://ccip.chain.link/msg/0xa1610d1de747df04d0fa3cb599d5300b5f1317909bb598d346688492c46d0022) |
| Solana | The same decision paused the Solana vault | [`2AFf5U…oyu2mB`](https://explorer.solana.com/tx/2AFf5UuStEtMTsew2xxnFhXx6CL1yfQMxZcPmpto1JQUBXYpdzpy1jQbMAg6kE4xTVTRgjbF8f9U7T2Nmfoyu2mB?cluster=devnet) |

**One decision, two chains.** One CRE run paused the Sepolia vault ([`0xcea844…def6ca`](https://sepolia.etherscan.io/tx/0xcea844416b0ae01a6f96c491cc63c905931454be92c4091bc373b2e544def6ca)) and the [`sotto_vault`](https://explorer.solana.com/address/8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD?cluster=devnet) program's vault on Solana devnet ([tx](https://explorer.solana.com/tx/39R7rvrjVS4etn7wmMXsMge6jpc4JRwnekpVsUmK6kMjQTVovoXeAY2i4Df3NJnmbZ8iWxGxNNmK4VaqPF3PiUHM?cluster=devnet)); both events carry the same run, revision and policy hash. A Solana grant was [paid while active](https://explorer.solana.com/tx/cAMvEBAzY1nWaApTbe1Fyo6zvhVHzvGrDJf2TfdoN9CN5MrzzECSPwgmBMgun5vCvSTHLTLmEETjVMaRYWju3mp?cluster=devnet) and refused on chain (`SpendingIsPaused`) after the pause. [Evidence](demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json).

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
bun run verify:evidence demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json   # the Ethereum + Solana decision
# Requires CRE authentication; no broadcast or private signing key:
bun run test:e2e
# With the owner's keys in .env: deploy the v3 vault and prove sweep, pay and CCIP evacuation
bun run deploy:sepolia && bun run prove:actions
```

`bun test` includes real local-chain runs: Anvil (`tests/anvil-integration.test.ts`, the vault's actions and their limits) and a local Solana validator (`tests/solana-integration.test.ts`) when Foundry and the Solana CLI are installed. These use the explicit research runner and never certify CRE execution.

Honest boundaries: CRE runs here as the CLI simulation broadcasting through Chainlink's forwarders on Sepolia and Solana devnet, not a deployed DON. Agent turns take tens of seconds; transcription is real time.

The accepted E2E harness uses a disposable backend/SQLite and official MCP, evaluates a contradictory condition through the real CRE CLI, checks frozen-monitor behavior and restart persistence, then independently verifies the saved public receipt. A missing CRE login fails honestly. The prior direct local harness requires an explicit research flag and cannot certify CRE execution.

Browser voice proof used synthetic spoken input through real MediaRecorder, local Whisper, Codex and live market discovery; no ambient human microphone or chain action was claimed. [Audio bounds verification](demo/voice-api-validation.json).

`bun run build` serves the production app from [the backend](http://127.0.0.1:4318). Services bind to localhost. Optional private-tailnet sharing is not started automatically.

[Execution contract](docs/execution-contract.md) · [CRE setup](docs/cre-integration.md) · [Environment options](.env.example) · [Operator guidance](operator/AGENTS.md)
