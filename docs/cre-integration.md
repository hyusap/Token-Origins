# Chainlink CRE execution

CRE is the sole product execution authority. Semantic API 7 exposes the implemented vault workflow (`pause-vault`, `sweep`, `pay`, `evacuate` through CCIP) and refuses standalone transfers, swaps, direct local/testnet runs and copy-trading. Missing authentication, funding or receiver readiness fails closed; there is no replacement signer.

## Execution path

```text
Spoken/typed intent → Codex → validated MCP graph → frozen revision/receiver
→ CRE HTTP/EVM observations → shared graph evaluator → runtime.report()
→ EVM writeReport() → Sepolia forwarder → GrantVault.onReport()
→ independent receipt/event/historical-state verification
```

Exchange sources are read through the CRE HTTP capability with field aggregation. Chainlink feeds bind exact registered network/address; vault state uses the CRE EVM capability. The workflow supports HTTP-trigger payloads assembled from typed graphs rather than arbitrary agent-generated code. Coinbase discovery previews do not substitute for a run's CRE readings.

The current path uses **CRE local simulation with public Sepolia broadcast**. It is not a deployed DON workflow or production oracle-consensus claim. Backend polling can invoke this workflow repeatedly, but is not a DON cron/log trigger. The Sepolia simulation forwarder is appropriate only for this explicit simulation proof.

## Verified public evidence

[Pause transaction](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec), block **11861492**, receiver `0x7f0d5e4c98ec1f2c7781e2ae60b0272e6d9a5aa1`.

The saved graph/hash/run/revision match the actual transaction and `SpendingPaused` event. Independent RPC reads establish paused state at that receipt block. A later owner resume is recorded separately; historical confirmation does not assert current spending state.

```sh
bun run verify:proof
```

[Fresh owned-receiver simulation evidence](../demo/sepolia-evidence-2026-10-07T09-06-03-441Z.json) · [Independent policy/receipt verification](../demo/sepolia-current-proof-verification.json) · [Second RPC verification](../demo/sepolia-current-alternate-rpc-verification.json).

The current owned receiver is `0x3bacbd3a15dabc479e9654e92273cfbb53499a73`. Deployment replaces the default manifest only after verification and archives the previous receiver identity in `contracts/deployments/`, preserving historical receipts.

## Setup

```sh
bun install --cwd cre
bun run --cwd cre install:cli
cre/bin/cre login
bun run --cwd cre typecheck
bun run --cwd cre build:wasm
```

Use the application's report-v2 deployment manifest, or deploy an owned receiver with `bun run sepolia:deploy` using a funded Sepolia test wallet. Supply `CRE_ETH_PRIVATE_KEY` privately for broadcast, and `CRE_API_KEY` only if using API-key authentication instead of normal CLI login. No personal credential files are opened. `ORIGINS_CRE_DEPLOYMENT_FILE` selects the manifest; explicit receiver overrides must remain consistent with the frozen target. The default manifest is `contracts/deployment.sepolia.json`.

`ORIGINS_CRE_GAS_LIMIT` defaults to 2,000,000. A past 350,000 budget allowed a forwarder transaction while receiver execution ran out of gas; independent event/state verification caught it. A transaction hash alone never establishes successful action delivery.

```sh
bun run test:boundary
# Authenticated real CLI evaluation; no signing or broadcast:
bun run test:e2e
# Explicit public write proof for a configured, funded, owned test receiver:
bun run sepolia:prove
bun run dev
```

The inspector reads `/api/cre/capabilities`: CLI installation/authentication, receiver configuration and signing-key presence are separate from verified funding. It never exposes account details or key values.

## Receiver and recovery

Report v2 binds version, receiver, chain, run hash, revision, policy hash, pause action and decision timestamp. The receiver authenticates its immutable forwarder and checks domain, expiry and replay protection. Submitted hashes are durably recorded before receipt waiting; uncertain outcomes reconcile read-only against the original target.

Monitors freeze the graph/target, use CRE dry evaluation before a fresh CRE write evaluation, and stop after verified settlement. Backend restart pauses checks. Archived direct/local/Solana jobs cannot reactivate or satisfy a CRE job's settlement requirement.

Production DON deployment requires deploy access, supported triggers, funded billing, real forwarder configuration, workflow metadata authorization and a verified deployed execution. These are remaining milestones, not implied by the saved simulation receipt.

## Deferred copy trading and Solana transfers

CRE supports report delivery to appropriate EVM receivers and Solana transfers programs. This product has neither a funded CRE swap receiver nor a deployed Solana transfers `on_report` program. Its standalone direct signer experiments are disabled, hidden from HTTP/MCP discovery and absent from advertised actions. [Copy-trading requirements](cre-copytrading-feasibility.md).

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

- [CRE overview](https://docs.chain.link/cre)
- [HTTP simulation](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/testing-in-simulation)
- [Consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)
- [Submitting reports](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/submitting-reports-onchain)
- [Solana Write](https://docs.chain.link/cre/capabilities/solana-write)

See [execution contract](execution-contract.md) for graph and API invariants.

## Actual deploy-access check

On October 7, 2026, the authenticated CLI reported deployment access is not enabled for this organization. The account-access command unexpectedly submitted a request despite `--non-interactive`; submission succeeded, but approval is pending. Both private and onchain registries were listed as available registry types. Private registry management avoids mainnet registry gas, but still requires deploy approval. [Recorded CLI result](../demo/cre-deploy-access-verification.json). The app still needs a deployed-workflow gateway adapter, deployed forwarder/metadata authorization and live DON execution verification after approval.
