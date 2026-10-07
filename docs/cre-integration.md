# Treasury policy execution

The canvas composes a **bounded policy graph**, not a native CRE graph and not generated code. Every execution path validates the same graph, checks its structural policy hash, reads only the sources it names, and evaluates it with the same mandatory guards (`cre/graph.ts`). The full contract is in [execution-contract.md](execution-contract.md).

## Three explicitly different paths

**Fixture rehearsal** (no deployment configured). Live price inputs, an in-memory vault, and no transaction. Useful for UI work.

**Local EVM rehearsal** (default with `bun run dev`). `cre/runner.ts` reads the live Coinbase trade and any Chainlink feeds, reads the real Anvil vault, and evaluates the graph. It then delivers a v2 report through `LocalRehearsalForwarder` and requires three proofs: a successful receipt, a `SpendingPaused` event matching run, revision **and** policy hash, and a fresh `paused()` read. These are real local transactions. They do **not** invoke CRE or demonstrate DON consensus.

**CRE local simulation · Sepolia broadcast** (`ORIGINS_EXECUTION_MODE=cre`). `cre/workflow/handler.ts` reads the vault and every source through CRE capabilities (HTTP consensus for the trade, EVM reads for feeds on their own network) and evaluates inside CRE. It then calls `runtime.report()` and `EVMClient.writeReport()`. `--broadcast` changes real Sepolia state through the CRE MockForwarder while the simulation itself runs locally. This is not a deployed DON workflow.

## Guarantees in every path

- The graph is re-validated at the boundary (cycles, orphans, unknown feeds, more than 5 sources, hash mismatch) before any read.
- A simulated `sell` never writes. CRE refuses it before any read; local paths return labelled simulated evidence.
- A vault that does not report `reportVersion() == 2` is refused before submission.
- A feed is read from the network and aggregator address the policy names. CRE refuses a network with no RPC in `cre/project.yaml` rather than substituting one.
- Each source must be fresh (trade ≤ 120 s; feed within its heartbeat window). A pause also requires the vault to be active. A missing input fails the run rather than evaluating as false.
- CRE reads: 3 vault calls + 1 per feed, capped by the 5-source limit (quota is 10).

## Report v2 and receiver

`abi.encode(version=2, target, chainId, keccak256(runId), revision, policyHash, action=1, decidedAt)`.

`GrantVault` accepts reports only from its immutable forwarder. It checks version, target, chain and action; a duplicate run id is a no-op; the report must be at most `maxReportAge` old and at most 60 s in the future. It emits `SpendingPaused(runId, revision, policyHash, decidedAt)` and blocks grant payments while paused. It does not re-evaluate the policy; the forwarder-authenticated workflow decides, and the event's hash identifies which graph did.

## Sepolia: deploy and prove

You need a CRE account and a fresh, funded Sepolia test wallet. Nothing here reads your desktop credentials; the CRE CLI authenticates itself.

```sh
bun run --cwd cre install:cli          # pinned v1.37.0, checksum-verified (macOS/Linux)
cre/bin/cre login                      # browser login; or export CRE_API_KEY
export CRE_ETH_PRIVATE_KEY=0x…         # funded Sepolia test wallet (≥ 0.05 SepoliaETH recommended)
bun run scripts/deploy-sepolia.ts      # deploys GrantVault v2 trusting the CRE MockForwarder
export ORIGINS_SEPOLIA_VAULT=0x…       # printed by the deploy script
bun run scripts/prove-sepolia.ts       # false → pause → duplicate → sell refused, then verifies
```

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

## Deployed DON (separate milestone)

Not done. It requires CRE deploy access (`cre account`), HTTP-trigger `authorizedKeys` (the simulation trigger uses `{}`, which deployed workflows reject), a production forwarder, and receiver binding to the deployed workflow identity. Simulation evidence must not be described as DON execution.
