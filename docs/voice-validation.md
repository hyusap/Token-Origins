# Observed rehearsal: 6 October 2026

The first complete 13-cue take ran at 12:43–12:49 Singapore time. A real Codex CLI agent made **31 actual MCP calls**, including named focus, policy composition, clarification, revision, asynchronous run submission, evidence inspection, and fresh contract reads. Raw model event streams are in `.data/agent`; `.data/rehearsal-report.json` contains the latest take, and `.data/rehearsal-full.log` records the original filming run.

Portable evidence is saved in `demo/rehearsal-report.json`, with a concise index in `demo/evidence-summary.json`. These copies retain tool names, operation IDs, source observations, immutable run inputs, condition decisions, transaction evidence, and measured timing. They omit machine-local file paths, full conversational transcripts, authentication data, and CLI stderr.

| Observation | Result |
| --- | --- |
| Discovery | Live Coinbase ETH/USD source timestamp and actual Anvil grant vault read; 1.2049 ETH |
| Conversational reference | Focused the price, then composed the rule using “this” |
| Ambiguity | “Focus on the condition” highlighted three candidates; the agent asked which condition and recovered from “The freshness condition” |
| False condition | Revision 3, $1 threshold: live price $2,701.93; no report or transaction |
| Explicit test revision | Revision 4: $2,835.66 threshold, 5% above the freshly fetched price |
| Actual pause | Execution fetched $2,700.49, observation age 1.1 seconds, and an unpaused vault; delivered the ABI report to the local forwarder |
| Receipt and receiver | Successful block-5 receipt, matching `SpendingPaused` event, and fresh `paused() = true` read |
| Immutable execution | Draft revision 5 changed to $1; run revision 4 retained its $2,835.66 snapshot |
| Already paused | Revision 6 produced a no-op; paused-state guard blocked a second report and transaction |

The confirmed local run ID is `run-f2a61b66-7ef9-4dde-ac9b-336251d04361`. Its transaction hash is `0x5ba44057baa6627b4b895565206cabc4d0e19bffd7f6877aef99e1b3b106909e`, on Anvil chain ID 31337. This is real local EVM execution. It demonstrates neither Sepolia broadcast nor CRE runtime execution/DON consensus.

Agent turn duration ranged from **17.114 to 35.260 seconds**, with a **20.608-second median** over these 13 turns. These are prompt submission through Codex completion measurements, including tool work. They exclude microphone/audio/transcription and must not be described as voice latency.

Browser render acknowledgements were observed for 18 semantic operations. During this take, repeated execution-progress broadcasts could overwrite an operation's initial acknowledgement, inflating its recorded delay. Those values remain in the raw report for audit; they are not presented as reliable first-render performance. The final implementation preserves the first acknowledgement for each operation. The follow-up probe and second full take below measured that corrected path.

The planned draft revision arrived **after** the fast local chain run had completed. Immutability is proven; actual voice interruption during an in-flight chain transaction is not. Built-in desktop microphone interaction remains untested, as requested for this preplanned rehearsal phase. See `voice-rehearsal.md` for the exact future voice-session setup and test.

## Follow-up semantic navigation probe

After the complete take, one real Codex turn made eight MCP calls in 30.536 seconds. It focused on the price, followed and pinned its source, returned to the whole rule, removed the vault-state guard at expected revision 6, undid that removal at expected revision 7, selected the previously confirmed revision-4 execution, and refreshed the vault read. Draft revision 8 restored the original threshold and guards.

All nine probe assertions passed: the source is visible and pinned; draft conditions were restored; revision checks were correct; the older confirmed run is selected; no run tool was called; run count and immutable run evidence are unchanged; and Anvil remained at block 5. Evidence is saved in `demo/navigation-report.json`.

Seven semantic state changes received browser acknowledgements after the first-acknowledgement fix. Commit-to-acknowledgement measurements ranged from 15 to 24 ms, with a 17 ms median. These include delivery, the browser animation-frame callback, and the return request to the backend; they do not measure microphone input or prove every intermediate camera animation was individually observed.

## Keyboard inspection probe

The keyboard transcript prompt “Show me the confirmed pause and explain it in one sentence” produced four actual MCP calls in 22.012 seconds: `get_context`, two `get_run` calls to locate the older confirmed receipt, and `inspect_object` with a fresh vault read. All six assertions passed; no run was submitted, run count stayed unchanged, and the confirmed revision-4 receipt was selected. Evidence is saved in `demo/ui-inspection-report.json`.

The vault read returned `paused = true`. Its block timestamp was `2026-10-06T04:47:31.000Z`; the read was fetched at `2026-10-06T05:00:29.932Z`. These record different events: the block's observation time and the later RPC fetch time. Fetching the latest block does not give that block a new timestamp.

## Second full measured take

The second take ran at 13:05–13:11 Singapore time, started with Space in the live browser. All 13 cues completed through **31 actual MCP calls**, and all seven execution assertions passed. `demo/final-rehearsal-report.json` preserves this take separately from the original. The four packaged probes at that point proved **74 actual MCP calls**.

The confirmed revision-4 run is `run-29f056c4-809a-4edb-b563-399624c586e1`. Its frozen threshold was $2,840.11; execution fetched $2,705.07 from the live source at `2026-10-06T05:09:29.802275518Z`. Transaction `0x02f81a058f1e52a9698aec7635f7001ba8c37ed4036e54d2f357b3501f0b94d0` succeeded in Anvil block 7, with a matching receiver event and a verified paused state. The false-condition run and already-paused run sent no transaction.

| Measured quantity | First take | Second take |
| --- | ---: | ---: |
| Actual MCP calls | 31 | 31 |
| Agent turn minimum | 17.114 s | 17.729 s |
| Agent turn median | 20.608 s | 21.424 s |
| Agent turn maximum | 35.260 s | 30.568 s |
| CLI-reported input tokens | 764,481 | 663,426 |
| CLI-reported cached input tokens | 489,088 | 485,248 |
| CLI-reported output tokens | 2,847 | 2,669 |

Input token totals decreased by 13.2% between these independent takes. The median agent turn took slightly longer; these observations do not establish that compaction caused any timing change. Input-token totals include cached tokens, whose counts are reported separately; they are not a billing estimate.

The MCP compaction helper omits repeated chart histories and keeps full execution logs and evidence on `get_run`. A controlled comparison of the same captured context reduced its structured payload from 17,611 to 6,491 bytes. Canonical HTTP and WebSocket canvas state stays complete. Tests verify that compaction preserves selected immutable run evidence, source provenance, revision checks, and clarification data without mutating canonical state.

The second take measured 18 corrected commit-to-browser-render acknowledgements: 8–20 ms, median 13 ms. This measures WebSocket delivery, a browser animation frame, and the acknowledgement request. It excludes microphone capture, transcription, model inference, and individually observed intermediate camera animations. The planned revision again arrived after the local run completed, so actual in-flight voice interruption remains untested.

After this take, an execution-price metadata correction removed inherited discovery `tradeId` and chart history from future execution snapshots, and updates the canonical chart with only the actual execution observation. Portable evidence omits those inherited fields; raw historical reports remain as observed. This correction does not change the frozen execution price, threshold, source timestamp, transaction receipt, or assertions reported above.

## Final metadata and recovery probe

At 13:16 Singapore time, a keyboard transcript requested a $1 false-condition run, undo, a fresh price and pinned source, then the confirmed revision-4 receipt. The real Codex turn completed in 46.352 seconds with ten MCP calls: nine succeeded and one direct focus on a synthetic run ID was rejected as undiscovered. The model recovered with `get_run` and selected the requested receipt. That failure and recovery remain in `demo/final-probe-report.json`; the five packaged probes prove **84 actual MCP calls** in total.

All 14 final assertions passed. Exactly one new run was added: revision 7, frozen threshold $1, actual execution price $2,703.28, no-op with no transaction. Undo restored the revision-6 parameters as draft revision 8. Its price snapshot has no inherited trade ID and contains exactly one chart point matching its own actual execution price and source timestamp. A later source refresh returned $2,703.67 and 100 actual exchange trade observations, with the latest point matching the displayed price and timestamp. The source is visible and pinned.

Every older run remains byte-for-byte unchanged, the confirmed revision-4 receipt remains selected, and the persistent Anvil restore still reports block 7 and paused spending. The fresh vault block timestamp is `2026-10-06T05:09:31.000Z`; the later read was fetched at `2026-10-06T05:16:41.173Z`. Eight semantic render acknowledgements measured 9–33 ms, median 15.5 ms. These exclude activity captions, model inference, and microphone capture. The preserved real-agent probe records the behavior observed before the direct-run-focus fix.

## Direct run focus after the fix

At 13:20 Singapore time, the keyboard prompt “Focus on the confirmed revision four execution” produced two actual MCP calls in 22.027 seconds: `get_context`, then successful `focus_object` with the semantic `run:<runId>` reference. It required no recovery or `get_run` fallback. All ten assertions passed: draft revision 8, all four run-record and frozen-snapshot hashes, the pinned source, selected confirmed revision 4, and chain block 7 remained unchanged. The focus render acknowledgement was 5 ms. `demo/direct-run-focus-report.json` saves the separate verification; all six packaged probes now prove **86 actual MCP calls**. The earlier failure and recovery remain preserved as observed.
