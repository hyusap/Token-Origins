# Treasury policy execution

The canvas composes a **bounded policy graph**, not a native CRE graph and not generated code. Every execution path validates the same graph, checks its structural policy hash, reads only the sources it names, and evaluates it with the same mandatory guards (`cre/graph.ts`). The full contract is in [execution-contract.md](execution-contract.md).

## Three explicitly different paths

**Fixture rehearsal** (no deployment configured). Live price inputs, an in-memory vault, and no transaction. Useful for UI work.

**Local EVM rehearsal** (default with `bun run dev`). `cre/runner.ts` reads the live Coinbase trade and any Chainlink feeds, reads the real Anvil vault, and evaluates the graph. It then delivers a v2 report through `LocalRehearsalForwarder` and requires three proofs: a successful receipt, a `SpendingPaused` event matching run, revision **and** policy hash, and a fresh `paused()` read. These are real local transactions. They do **not** invoke CRE or demonstrate DON consensus.

**CRE local simulation · Sepolia broadcast** (`ORIGINS_EXECUTION_MODE=cre`). `cre/workflow/handler.ts` reads the vault and every source through CRE capabilities (HTTP consensus for the trade, EVM reads for feeds on their own network) and evaluates inside CRE. It then calls `runtime.report()` and `EVMClient.writeReport()`. `--broadcast` changes real Sepolia state through the CRE MockForwarder while the simulation itself runs locally. This is not a deployed DON workflow.

## Guarantees in every path

- The graph is re-validated at the boundary (cycles, orphans, unknown feeds, more than 5 sources, hash mismatch) before any read.
- A simulated `sell` never writes. CRE refuses it before any read; local paths return labelled simulated evidence.
- The runner reads `reportVersion()` and sends what the vault accepts: v3 to a GrantVault v3 (pause, sweep, pay, evacuate), v2 to the pause-only vault already on Sepolia; anything else is refused before submission.
- A feed is read from the network and aggregator address the policy names. CRE refuses a network with no RPC in `cre/project.yaml` rather than substituting one. Proof of Reserve, token supply and lending rates are read from their registry contracts on mainnet with the same call plan the backend uses (`cre/onchain-reads.ts`).
- Each source must be fresh (trade ≤ 120 s; feeds within their heartbeat window; contract state read in the run). Each action has its vault guard (active for a pause or payment, funds for a sweep or payment, tokens for an evacuation). A missing input fails the run rather than evaluating as false.
- CRE reads: up to 5 vault calls + at most 2 per source, capped by the 5-source limit (quota is 15).

## Report v3 and receiver

`abi.encode(version=3, target, chainId, keccak256(runId), revision, policyHash, action, decidedAt, flags, payeeId, amount, destinationChainSelector)`: action 1 pause, 2 sweep (amount in bps, flag 1 also pauses), 3 pay (payee id and wei), 4 evacuate (bps and the CCIP chain selector, flag 1 also pauses). The v2 layout (first eight fields, pause only) is still produced for the v2 vault already on Sepolia.

`GrantVault` accepts reports only from its immutable forwarder. It checks version, target, chain, action and flags; a duplicate run id is a no-op; the report must be at most `maxReportAge` old and at most 60 s in the future. Every movement is bounded at deploy: sweeps go only to the immutable `reserve` (capped by `maxSweepBps`), payments only to payees the owner registered (≤ `maxPaymentWei`, at most once per `minPaymentInterval`, never while paused), evacuations only to `reserve` on the one CCIP destination fixed at deploy, with the CCIP fee paid in ETH. Events `SpendingPaused`, `ReserveSwept`, `GrantStreamed` and `TreasuryEvacuated` (with the CCIP message ID) each repeat run, revision and policy hash. It does not re-evaluate the policy; the forwarder-authenticated workflow decides, and the event's hash identifies which graph did.

## Standing policies: the cron trigger

The workflow registers two triggers: HTTP (index 0) and cron (index 1). `watch_policy` re-checks one frozen revision on a schedule; in CRE mode each check writes the frozen request into the workflow config and runs `cre workflow simulate --trigger-index 1`, so the decision is made by the cron handler (`onCron`). Evidence records `trigger: "cron"`. 30 seconds is the fastest CRE cron schedule. A deployed DON would run the same handler on its schedule.

## Sepolia: deploy and prove

You need a CRE account and a fresh, funded Sepolia test wallet. Nothing here reads your desktop credentials; the CRE CLI authenticates itself.

```sh
bun run --cwd cre install:cli          # pinned v1.37.0, checksum-verified (macOS/Linux)
cre/bin/cre login                      # browser login; or export CRE_API_KEY
export CRE_ETH_PRIVATE_KEY=0x…         # funded Sepolia test wallet (≥ 0.05 SepoliaETH recommended)
bun run deploy:sepolia                 # deploys GrantVault v3 trusting the CRE MockForwarder, funds it, registers payees, drips CCIP-BnM
export ORIGINS_SEPOLIA_VAULT=0x…       # printed by the deploy script
bun run prove:sepolia                  # false → pause → duplicate → sell refused, then verifies
bun run prove:actions                  # sweep → pay through the cron trigger → CCIP evacuation, then verifies
bun run verify:registry                # every feed, PoR, token, lending and CCIP address checked on chain
```

`prove:actions` writes `demo/actions-evidence-<timestamp>.json`; `verify:evidence` re-checks it: each graph's hash, each receipt, the vault's own event for that run moving what the evidence says to the configured reserve or registered payee, and the CCIP message ID. The evacuation's tokens arrive on Base Sepolia about 20 minutes later; follow the printed `ccip.chain.link` link.

`prove-sepolia.ts` writes `demo/sepolia-evidence-<timestamp>.json` and re-verifies it from chain data: receipt, event fields, policy hash recomputed from the stored graph, and paused state at the receipt block. Anyone can repeat the check:

```sh
bun run scripts/verify-evidence.ts demo/sepolia-evidence-….json
```

The default proof graph reads the **mainnet** Chainlink BTC/USD feed (the same aggregator the canvas shows) and writes on Sepolia. If your CRE environment cannot read mainnet, use the Sepolia feed instead: `bun run scripts/prove-sepolia.ts --feed-network ethereum-sepolia`.

The MockForwarder address used is `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` (CRE forwarder directory, Ethereum Sepolia); override it with `ORIGINS_SEPOLIA_FORWARDER`. A private RPC can go in `ORIGINS_SEPOLIA_RPC` and `cre/project.yaml` locally; never commit RPC tokens.

## Local verification

```sh
bun install --cwd cre
bun run --cwd cre typecheck && bun run --cwd cre test && bun run --cwd cre build:wasm
forge test --root contracts -vv
forge build --root contracts && bun test tests      # includes the real-Anvil integration test
bun run dev                                          # in another terminal, then:
bun run scripts/verify-local.ts                      # live prices, real local transactions
```

The development wallet is Anvil's public account, accepted only on localhost chain 31337.

## Solana: the same decision on a second treasury

`contracts/solana/programs/sotto_vault` is an Anchor program holding devnet SOL. `pay_grant` moves SOL and is refused while paused, and `on_report` accepts a pause only through the keystone forwarder recorded at `initialize`. It verifies the forwarder-authority PDA the forwarder signs with (Chainlink's receiver pattern), binds the report to this vault account, version, action and age, records the run, revision and policy hash, and emits `SpendingPaused`. The owner resumes.

When `ORIGINS_SOLANA_VAULT` is set, the CRE workflow evaluates the policy once. If it acts, the workflow writes the EVM report to Sepolia and then a 114-byte Borsh report (same run hash, revision and policy hash) to Solana devnet through `SolanaClient.writeReport` and CRE's simulation forwarder (`7kuEAA3m…cNK`, state `5Tipz3yh…MP7`). The runner confirms the Solana transaction, the matching `SpendingPaused` event and a fresh vault read before it calls the run confirmed. CRE runs off-chain (simulator or DON); it is not deployed on Solana. It writes to Solana.

```sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # Solana CLI
bun run solana:wallet        # devnet key saved to .env; fund ~5 SOL at faucet.solana.com
bun run deploy:solana        # deploys contracts/solana/build/sotto_vault.so, creates a 0.5 SOL vault
echo 'ORIGINS_SOLANA_VAULT=…' >> .env
bun run prove:multichain     # one decision pauses Sepolia + Solana; grant paid before, refused after
```

Recorded proof: one decision paused Sepolia ([tx](https://sepolia.etherscan.io/tx/0xcea844416b0ae01a6f96c491cc63c905931454be92c4091bc373b2e544def6ca)) and Solana devnet ([tx](https://explorer.solana.com/tx/39R7rvrjVS4etn7wmMXsMge6jpc4JRwnekpVsUmK6kMjQTVovoXeAY2i4Df3NJnmbZ8iWxGxNNmK4VaqPF3PiUHM?cluster=devnet)), with a grant paid before and refused after; `demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json`.

**Sweeps on Solana.** Program v3 also accepts a 117-byte `ActionReport` (v2's fields, then flags and bps) that sweeps a share of the vault's SOL to the reserve the owner set with `configure_reserve` (PDA `["treasury", vault]`). v2 pause reports keep working, so the existing vault is upgraded in place:

```sh
bun run solana:enable-sweep  # upgrades sotto_vault on devnet (≈2 SOL buffer, refunded) and configures the reserve
```

After that, a sweep decision moves ETH on Sepolia and SOL on Solana in the same run. `tests/solana-upgrade.test.ts` rehearses exactly this upgrade on a local validator, starting from the binary deployed on devnet today (`contracts/solana/build/legacy/sotto_vault_v2.so`).

The built program and its devnet program keypair are committed, so no Rust or Anchor install is needed. To rebuild: `cargo-build-sbf --tools-version v1.43` in `contracts/solana`. `tests/solana-integration.test.ts` runs both programs on `solana-test-validator` with a forwarder stand-in (`mock_forwarder`, test-only).

## Deployed DON (separate milestone)

Not done. It requires CRE deploy access (`cre account`), HTTP-trigger `authorizedKeys` (the simulation trigger uses `{}`, which deployed workflows reject), a production forwarder, and receiver binding to the deployed workflow identity. Simulation evidence must not be described as DON execution.
