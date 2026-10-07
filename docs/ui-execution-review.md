# UI integration review

Reviewed execution-contract.md sections 1–9 and integrated section 10 on top of `claude/phone-control-vcfq87`. No engine, shared execution types, CRE workflow or receiver changes are included.

The graph vocabulary, source identities, precision, structural policy hash, result roles, frozen request, execution modes, report confirmation and fresh-run lifecycle work for the UI. The canvas draws every input reference separately, including nested AND/OR/NOT. Selected runs use their archived graph and observations. Missing archived readings are explicitly unavailable, never replaced with current market values.

Two contract notes:

- Exchange coverage remains ETH-USD only. SOL exchange observations are still unsupported triggers; the UI discloses this. A Chainlink SOL feed is a different source and is not silently substituted.
- `legacy-rule.json` has different text in `expected.policySentence` and `state.workflow.summary`. Draft presentation uses `workflow.summary`, per section 10; frozen-run presentation describes the archived graph. Fixture tests verify both representations rather than modifying the engine or fixtures.

Run evidence and completion captions distinguish the policy verdict, mandatory checks and intermediate results. A false intermediate inside a passing OR is neutral. No-op narration uses `noopReason`; failed writes use `error`. Simulated orders and fixture pauses make no on-chain claim. Transaction and block details appear only with a transaction hash.

Operator guidance covers composition, explicit source networks, immutable run inspection, simulation, fresh runs after completion, operation-ID retries and uncertain runs. The browser's microphone waveform remains local audio metering; this work verifies transcribed-text presentation and operator guidance, not end-to-end speech recognition or a live spoken command.

For review, run `bun run web -- --port 5174` and open `http://127.0.0.1:5174/?fixture=nested-and-or-not`. All nine `fixtures/states/*.json` names work with `?fixture=<name>` in development. The fixture preview does not connect to the backend and rejects writes. This preview is excluded from production builds.
