# Treasury policy execution

The canvas composes a **bounded application specification**, not a native CRE graph and not arbitrary generated code. It freezes `runId`, revision, USD threshold, and observation freshness before execution. The fixed HTTP-trigger workflow supports one allowlisted source (Coinbase ETH/USD ticker), one configured GrantVault receiver, a numeric `<` comparison, freshness, vault-state guard, AND, and a pause report. A draft can omit visible guard nodes; execution always preserves the freshness cap and already-paused guard as treasury safety invariants.

## Two explicitly different paths

**Default: Local EVM rehearsal.** `cre/runner.ts` fetches a real timestamped Coinbase ticker, reads a real isolated Anvil contract, evaluates the same bounded rule in a separate runner, delivers an ABI-encoded report through `LocalRehearsalForwarder`, then requires a successful mined receipt, a correlated `SpendingPaused` event, and a fresh `paused()` read. This demonstrates actual local contract behavior. It does **not** invoke the CRE runtime or demonstrate DON consensus. The backend initiates execution and renders evidence; it does not implement transaction submission.

**Optional: CRE local simulation · Sepolia broadcast.** `cre/workflow/main.ts` uses CRE's HTTPClient and EVMClient to fetch and read fresh inputs, evaluates inside CRE, generates `runtime.report()`, and submits `EVMClient.writeReport()`. The runner supplies only the immutable specification; it verifies the returned report transaction and post-state. `--broadcast` changes actual testnet state while simulation itself still runs locally. This is not a deployed DON workflow.

No user credentials were inspected, and no testnet execution is claimed. The CRE TypeScript workflow was typechecked and compiled to actual WASM using SDK 1.23.0. CLI v1.37.0 was installed under `cre/bin/cre` after verifying the official release SHA-256 digest.

## Verified local evidence

`contracts/evidence.local.json` records the real external price and timestamp, false/no-transaction run, successful local pause, already-paused no-op, and repeated-run deduplication. Addresses and hashes are actual localhost Anvil values, not Sepolia evidence. `contracts/deployment.local.json` contains the deployed contract addresses. `scripts/verify-local.ts` verifies the whole sequence and resumes the vault at the end so the demo begins with spending active.

Commands run successfully:

```sh
bun install --cwd cre
# Optional CLI installation, pinned official binary with checksum check:
bun run --cwd cre install:cli
bun run --cwd cre typecheck
bun run --cwd cre build:wasm
bun run --cwd cre test
forge test --root contracts -vv
# Keep this localhost node running in a separate terminal:
anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --silent
bun run scripts/deploy-local.ts
bun run scripts/verify-local.ts
```

The development wallet is Anvil's publicly documented development account and is accepted by the runner only at `http://127.0.0.1:8545` with chain ID 31337. Do not fund it on a public network.

## Sepolia setup when ready

1. Create your own Chainlink CRE account. Use an explicitly supplied fresh `CRE_API_KEY`; current Chainlink documentation says API-key authentication requires deployment access. Interactive `cre login` is an alternative for manual CLI work, but the app runner intentionally requires an explicit API key and does not inspect existing desktop credentials.
2. Create and fund your own fresh Sepolia test wallet. Set `CRE_ETH_PRIVATE_KEY` privately in your environment.
3. Deploy `GrantVault` on Sepolia with the **simulation MockForwarder** address `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` and max report age 120 seconds. Check the current forwarder directory before deployment. The local rehearsal forwarder is not used by CRE.
4. Set `ORIGINS_EXECUTION_MODE=cre`, `ORIGINS_SEPOLIA_VAULT`, and the two CRE environment variables. The runner uses the Sepolia selector `16015286601757825753` and the configured project's public Sepolia RPC. A private RPC can be placed directly in `cre/project.yaml` locally; never commit RPC access tokens.
5. Run with threshold `$1` for an observed false condition, then create a new revision with a threshold above the fresh observed price for the true case. Each execution fetches its own fresh input; a changing market can still affect the result.

The executable CLI form is:

```sh
cd cre
./bin/cre workflow simulate ./workflow \
  --project-root . --target staging-settings --non-interactive \
  --trigger-index 0 \
  --http-payload '{"runId":"example-run","revision":1,"thresholdUsd":1,"maxAgeSeconds":120,"requireFresh":true,"skipIfPaused":true,"broadcast":false}' \
  --config workflow/config.runtime.json
```

The runner creates `config.runtime.json` from the explicit vault setting. Add `--broadcast` only for an intended true testnet action. The simulation trigger is configured with `{}` deliberately; deployed HTTP triggers require authorized signing keys.

## Report and contract checks

Report payload: `abi.encode(bytes32 keccak256(runId), uint256 revision, uint256 priceUsdCents, uint256 thresholdUsdCents, uint256 observedAtSeconds)`.

GrantVault implements `onReport(bytes,bytes)` and ERC165 receiver detection. It permits only its immutable forwarder, rejects future/stale observations and nonpositive/false threshold reports, suppresses replay by run ID, and blocks grant payments while paused. Seven Solidity tests cover these behaviors. Nine TypeScript tests include the actual CRE HTTP handler under the official capability mock harness, checking threshold decisions, stale/paused no-op behavior, correct EVM balance decoding, and receiver-revert failure. These SDK tests use explicitly mocked capabilities; they do not claim authenticated runtime execution. The mock forwarder is a simulation transport, so this deployment is strictly a demo. Before any production deployment, use a production KeystoneForwarder, bind workflow identity and chain domain, and review authorization and operational policy.

## Primary references

- [CRE HTTP simulation](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/testing-in-simulation)
- [CRE HTTP GET requests](https://docs.chain.link/cre/guides/workflow/using-http-client/get-request)
- [CRE TypeScript EVM reads](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-read)
- [Consumer contracts and mock forwarders](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)
- [Submitting reports and independent receiver status](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/submitting-reports-onchain)
- [Authentication and API-key requirements](https://docs.chain.link/cre/reference/cli/authentication)
- [Official CLI release](https://github.com/smartcontractkit/cre-cli/releases/tag/v1.37.0)
