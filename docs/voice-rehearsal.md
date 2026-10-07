# Voice and operator interaction

Woga has two inputs to the same semantic operator: typed commands and browser microphone dictation. Final text goes to `/api/agent`, a real Codex CLI turn calls Woga's MCP tools, and committed canvas state arrives over WebSocket.

## Browser microphone

From the project root:

```sh
bun run voice:setup
bun run dev
```

Voice setup requires `git`, `curl`, `cmake`, a C++ compiler and `ffmpeg`. It builds pinned whisper.cpp and downloads the checksum-verified `base.en` model into `.data/voice`. Setup needs network access; local transcription does not need an API key or send audio to an external service.

Open `http://127.0.0.1:5173` (or the built app at `http://127.0.0.1:4318`). Click **Mic**, allow microphone access, and speak one command. Local capture shows a real amplitude waveform, ends after speech followed by silence, and sends the recording to local Whisper. The final transcript is visible and submitted once through the same operator as typed input. Captures are bounded below the backend's 30-second / 5-MB limits; temporary decoder audio is deleted after processing or cancellation.

`GET /api/voice/capabilities` reports local readiness. If local transcription is unavailable, the client uses native browser speech recognition when supported. That browser service may process audio remotely; the UI identifies the provider. Unsupported browsers and permission/service failures leave the typed command path available. Reload the page after installing local voice to select it.

**Mic** or **Escape** stops capture or cancels pending transcription. Starting dictation stops browser speech playback. Once an agent command has been submitted, stopping audio does not cancel the semantic operation or a blockchain transaction. The Mic control remains disabled during submission; failed commands retain recognized text for review rather than automatically retrying.

## Verified browser evidence

[The browser verification](../demo/voice-browser-e2e-verification.json) records nine passing checks on 7 October 2026. A dedicated Chromium instance received synthetic spoken input through its test microphone, then used the production MediaRecorder, actual local Whisper and an authenticated Codex operator. The exact recognized instruction was:

> Show me the price of Solana. Keep this as a draft and do not execute anything.

The 6.54-second recording transcribed in 1.165 seconds. Exactly one semantic turn discovered a live Coinbase SOL trade at $118.43 with source timestamps and trade ID; that turn completed in 42.422 seconds. These are separate recording, transcription and operator measurements, not a general voice latency guarantee. The UI settled and released capture. The isolated test created no run, monitor or chain action. No user ambient microphone was captured; the synthetic audio and browser were removed after verification. [Rendered result](../demo/voice-browser-e2e.png).

This proves the browser dictation pipeline with synthetic spoken input. Human microphone behavior and Codex desktop voice are separate verification scopes.

## Manual interaction

The backend and canvas must be running, and the CLI account must be signed in. Type a command in the dock or use **Mic**. Each submitted command passes through a real `codex exec --json` turn and official MCP stdio transport. The bridge supplies authoritative canvas context, ignores incompatible global CLI configuration and uses the account's default model. Submit your next instruction after the current turn settles. There is no timed script or automatic cue playback.

Product execution uses Chainlink CRE as its sole action authority. The supported action is a bounded grant-vault pause through the version 2 receiver. Source reads and drafts alone do not prove CRE readiness. A run requires configured CRE source/receiver networks and actual execution evidence; there is no standalone signer fallback. See [CRE setup](cre-integration.md).

Clearing the canvas preserves contract state. Stopping microphone capture does not cancel an active semantic operation or submitted transaction.

| Key | Action outside text inputs |
| --- | --- |
| M | Start or stop dictation |
| `/` | Expand typed command input |
| Escape | Close overlays and stop dictation/transcription |
| I | Open proof |
| 0 | Fit canvas |

## Traces and endpoints

`.data/agent/agent-*.jsonl` contains actual CLI event streams. `CanvasState.latency` and `/api/rendered` acknowledgements measure committed state delivery/rendering; they exclude audio capture and transcription. The separate browser proof records actual transcription timing.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/voice/capabilities` | Local engine/model readiness and audio limits |
| `POST /api/voice/transcribe` | Audio FormData field `audio` → recognized transcript; no action submission |
| `POST /api/agent` | `{ "text": "Focus on the vault." }` → one semantic operator turn |
| `GET /api/agent/status` | Current operator progress |
| `GET /api/state` | Authoritative persistent canvas |

## Codex desktop voice

Open [the operator folder](../operator/README.md) as a trusted Codex project, start a new operator chat and confirm `woga` is connected through `/mcp`. If your desktop client offers voice, start the session there and grant microphone permission yourself. A suitable read-only test is: “Use Woga's MCP tools to show ETH's price and focus on it.”

This repository does not start, capture or emulate the desktop app's private voice session. The browser proof does not verify desktop audio, partial transcripts, interruption or desktop voice latency. Those require a separate observed user-started session. The operator uses project-local MCP configuration and does not modify global registrations or model settings.
