# Run Woga

Open this folder as the primary folder of a Codex project, then start a new chat here. The local `.codex/config.toml` attaches Woga's MCP and loads `AGENTS.md` as the operator instructions. This folder contains no application workspace for the agent to develop.

The parent application's backend must already be running at `http://127.0.0.1:4318`. Keep its canvas open beside the operator chat. Confirm `woga` is connected using `/mcp`, then type “Show me ETH's price and our grant vault.” If your desktop client offers **Start voice chat**, you can start a voice session yourself; that desktop route remains unverified by this repository's evidence.

The browser's **Mic** transcribes one spoken command and submits its final text to the same semantic operator. Run `bun run voice:setup` from the parent project before starting the app to install pinned whisper.cpp and the verified `base.en` model. Setup requires `git`, `curl`, `cmake`, a C++ compiler and `ffmpeg`. Local Whisper processes recorded audio on this machine, uses no transcription API key and deletes temporary decoder audio after processing. Allow microphone access on localhost or HTTPS; reload after setup. If local voice is unavailable, supported browsers can use their native speech service, which may receive audio remotely. The UI identifies the provider; typed commands remain available.

[Nine browser checks passed](../demo/voice-browser-e2e-verification.json): synthetic spoken input through a dedicated Chromium test microphone used the actual MediaRecorder, local Whisper and Codex semantic operator to discover a live SOL price. Exactly one recognized command was submitted, and no chain action occurred. No user ambient audio was captured. This proves browser dictation with synthetic input, not Codex desktop voice. **Mic** or **Escape** cancels capture/transcription; it does not cancel an already submitted operation. See [voice setup and evidence](../docs/voice-rehearsal.md).

From a terminal:

```sh
codex -C /Users/ayush/dev/token-origins/operator
```

For a read-only connectivity check:

```sh
codex exec -C /Users/ayush/dev/token-origins/operator "Read Woga's current context and summarize it. Do not mutate state or record this diagnostic as an utterance."
```

Start coding chats from the parent `token-origins` folder. Start operator chats from this folder. Existing chats keep their original instructions; create a new chat to load this operator setup. Project-local configuration requires a trusted project. Shell commands and live web search are allowed for operation and diagnostics; app connectors and multi-agent features are disabled. `AGENTS.md` prohibits application edits, delegation, and other integrations. The browser command bridge supplies the operator’s invocation settings. User-level MCP registrations can still be inherited by Codex and are not removed or edited here. The project MCP command runs from the operator directory; start Codex from this folder.

Typed and browser voice commands start their operator turns in this folder with the same `AGENTS.md`. The command bridge supplies current canvas state and publishes the utterance and completion response after the turn. Direct operator chats reuse state from tool responses and return a natural response without extra caption/activity calls. The app bridge ignores incompatible global CLI configuration and uses the account's default model. Its child environment retains runtime paths and normal Codex authentication, but excludes backend CRE, signing-wallet and RPC credentials. MCP disables dotenv loading and receives only the backend URL through its explicit configuration. Known credentials are redacted from model input, traces and stderr. Direct operator launches inherit your CLI settings; this setup does not change them.


Use **get capabilities** to inspect Chainlink CRE readiness and supported vocabulary. Policies compose exact exchange markets fetched through CRE HTTP or configured Chainlink feeds through CRE EVM with comparisons, freshness and boolean conditions. **CRE is the sole action authority:** the supported product action is a bounded grant-vault pause reported through CRE EVM write to the version 2 receiver. Direct signer swaps, copy-trading and Solana transfers are unavailable; they must never be silently replaced with a pause.

An explicit run evaluates once through CRE. evaluationOnly:true freezes no-broadcast authority and uses real CRE source reads/evaluation without report submission or signing; it does not produce an action receipt. Ask the operator to evaluate without broadcasting when you want a read-only run; broadcast requires explicit execution of a configured policy. Explicit activation schedules repeated CRE evaluations of the frozen pause policy while the backend runs, every 30 seconds by default, until a verified pause. This scheduler is not a deployed DON trigger. Restart pauses or marks jobs uncertain; read-only reconciliation does not submit or automatically resume. Clearing the canvas preserves contract state and does not unpause a vault. Execution evidence distinguishes local CRE simulation, broadcast and actual DON execution. Drafts and source reads alone do not prove CRE readiness or on-chain completion.

Source networks are immutable identities. CRE requires each selected network's RPC configuration, including a mainnet feed read for a Sepolia receiver. Mandatory source-age caps are 120 seconds for exchange trades and 26 hours for Chainlink feeds; explicit freshness nodes can tighten them. Confirmed pauses require the bound receiver receipt/event and actual vault state. There is no fallback to a standalone wallet signer.

`GET /api/agent/status` reports operator progress. Submit your own typed or spoken instructions; there is no timed script or automatic cue playback.
