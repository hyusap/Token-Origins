# Voice and agent rehearsal

Sotto preserves the preferred architecture: Codex interprets a conversational command, calls our custom MCP tools, and the backend updates the external canvas over WebSocket. The autonomous demo uses **preplanned text utterances and a real Codex CLI agent**. It does not emulate microphone audio, claim speech latency, or inject events into the desktop app's private voice session.

## Run the rehearsal

Start `bun run dev`, then open `http://127.0.0.1:5173`. In a second terminal run:

```sh
bun run rehearse --auto --reset
```

Each cue from `demo/script.json` goes through `codex exec --json`, the official MCP SDK's stdio transport, and semantic tools. No natural-language parser selects the action in this path. The CLI account must already be signed in (`codex login`); the bridge uses standard CLI authentication without reading or copying account files. Existing user configuration is ignored. It does not select a new model. Shell diagnostics and live web search are allowed; app connectors are disabled, and the operator instructions prohibit application edits, delegation, and other integrations. The model receives a bounded conversation transcript plus fresh authoritative MCP context each turn.

The script's `atSeconds` values are minimum offsets from rehearsal start. Turns are serialized, with six seconds between completed turns by default; late turns defer subsequent cues instead of dropping them. Execution runs can continue asynchronously. The special draft revision cue follows the run-return turn without the six-second gap. Depending on actual tool/model timing, the chain transaction may already have completed before that next turn. This is a draft revision test, not proof of audio barge-in during a transaction.

For a manual filming take:

```sh
bun run rehearse --reset
```

Press Enter for each next cue, or type a custom utterance. `/quit` and Ctrl+C stop future cues. They do not cancel an active semantic operation or blockchain transaction. No mouse interaction is required. In the canvas the keyboard rehearsal controls call the same bridge.

Canvas keyboard controls:

| Key    | Action                                                                                   |
| ------ | ---------------------------------------------------------------------------------------- |
| Space  | Start or stop the timed real-agent rehearsal                                             |
| `/`    | Open the transcript input; type an utterance and press Enter to send it to Codex         |
| Escape | Close the transcript input, stop future rehearsal cues, and stop optional caption speech |
| I      | Toggle the provenance and evidence inspector                                             |
| V      | Toggle browser narration of planned prompts and final responses                          |

Browser read-aloud is optional output narration. It does not listen to the microphone or verify desktop voice integration.

The script includes discovery, explicit focus, composition, freshness and paused-state guards, framing, deliberate ambiguity, named clarification, a false-condition run using a $1 threshold, an explicit above-current-price revision, execution, a draft revision, receipt inspection, and an already-paused guard test. Starting a rehearsal prepares the local Anvil vault with a verified owner `resume()` transaction if it was paused, then clears the canvas. This helper accepts only `http://127.0.0.1:8545` and chain ID 31337, using Anvil's public development key. It never resets a public-network vault. Clearing the canvas through the semantic reset tool alone never unpauses a contract.

## What is measured

`.data/agent/agent-*.jsonl` preserves the raw Codex event stream. `.data/rehearsal-turns.jsonl` preserves thread IDs, prompt timestamps, completion timestamps, duration, and actual MCP calls. Tool receipt/state commit measurements live in `CanvasState.latency`; the frontend sends `/api/rendered` acknowledgements after applying a state update. A real rendered acknowledgement can distinguish backend commit time from browser delivery/render time. None of these measurements include microphone onset, audio transcription, or desktop voice delegation.

Inspect `GET /api/rehearsal/status` for progress and completed turns. `POST /api/agent` accepts `{ "text": "Focus on the vault." }`. The backend supports `/api/rehearsal/start`, `/next`, and `/stop`. Rehearsal errors are visible captions, and raw stderr logs remain next to the event trace for diagnosis.

| Endpoint                    | Payload / return                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agent`           | `{ "text": "Focus on the vault." }` → one measured `AgentTurn`, including `ok`, `summary`, and actual MCP tool names |
| `POST /api/rehearsal/start` | `{ "mode": "auto", "reset": true }`; use `"manual"` for cue-by-cue control                                           |
| `POST /api/rehearsal/next`  | `{}` → next cue and its measured agent turn                                                                          |
| `POST /api/rehearsal/stop`  | `{}` → stop future cues; active operations can finish                                                                |
| `GET /api/rehearsal/status` | Current `running`, `busy`, `cueIndex`, `totalCues`, completed `turns`, next cue, and errors                          |
| `GET /api/state`            | Authoritative persistent graph, draft revisions, runs, evidence, provenance, and measured tool latency               |

## Prepare an actual desktop voice test

Open `operator/` as the primary folder of a Codex project and start a new chat there. `operator/AGENTS.md` defines the Sotto operator role; `operator/.codex/config.toml` loads it as the model instructions, permits shell diagnostics and live web search, disables app connectors, and attaches the Sotto MCP through `operator/mcp.ts`. The rehearsal starts its agents in the same folder and uses the same instructions. The parent project remains the development workspace. Existing chats do not switch roles automatically.

Verify `sotto` is connected in MCP settings or `/mcp`. The backend and canvas must already be running. If project configuration is not loaded, the equivalent local connection is:

```sh
codex mcp add sotto --env ORIGINS_BACKEND_URL=http://127.0.0.1:4318 -- bun run /Users/ayush/dev/token-origins/scripts/mcp.ts
```

That command modifies the user's Codex MCP configuration; it is provided for setup and was not silently run. Start the backend and canvas first, select **Start voice chat** in this task, and say: “Use only the Sotto MCP tools to show ETH's price and our grant vault, then focus on the price.” Then compose a rule, interrupt a spoken explanation to revise its threshold, and ask for current state. Measure the visible behavior and retain only observations actually made.

As of 6 October 2026, [official voice documentation](https://learn.chatgpt.com/docs/features/voice) describes GPT-Live, spoken task steering, and natural interruption. It requires the user to start the voice session and grant microphone access. [Official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes custom stdio tool connections. Those establish supported components; they do not establish end-to-end external canvas voice latency, partial transcript access, or an API to drive the desktop's internal audio session. The built-in microphone route remains unverified until the actual voice test.

If that route cannot meet interaction latency, an app-owned voice client can send final transcripts to `/api/agent` and retain the same semantic MCP/backend/canvas pipeline. That is a future integration and must be labelled separately. Browser speech recognition alone does not prove Codex desktop voice integration.

## CLI implementation references

[Non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode) documents JSONL events and standard CLI authentication. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `features.shell_tool`, MCP stdio command/args/env, and replacement model instructions. This implementation uses those supported settings rather than fabricating tool-call traces.
