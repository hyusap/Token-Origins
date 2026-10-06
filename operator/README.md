# Run Sotto

Open this folder as the primary folder of a Codex project, then start a new chat here. The local `.codex/config.toml` attaches Sotto's MCP and loads `AGENTS.md` as the operator instructions. This folder contains no application workspace for the agent to develop.

The parent application's backend must already be running at `http://127.0.0.1:4318`. Keep its canvas open beside the operator chat. Confirm `sotto` is connected using `/mcp`, then type a command or select **Start voice chat** and say “Show me ETH's price and our grant vault.” Native voice availability depends on the desktop client; the browser's Mic button displays amplitude and does not transcribe commands.

From a terminal:

```sh
codex -C /Users/ayush/dev/token-origins/operator
```

For a read-only connectivity check:

```sh
codex exec -C /Users/ayush/dev/token-origins/operator "Read Sotto's current context and summarize it. Do not mutate state or record this diagnostic as an utterance."
```

Start coding chats from the parent `token-origins` folder. Start operator chats from this folder. Existing chats keep their original instructions; create a new chat to load this operator setup. Project-local configuration requires a trusted project. Shell commands and live web search are allowed for operation and diagnostics; app connectors and multi-agent features are disabled. `AGENTS.md` prohibits application edits, delegation, and other integrations. Sotto tools use the same approval mode as the existing rehearsal. User-level MCP registrations can still be inherited by Codex and are not removed or edited here. The MCP command and working directory point to this checkout explicitly; update those two paths if you move it.

The automated rehearsal also starts its agents in this folder and uses this same `AGENTS.md`. Its transport supplies current canvas state from the backend's memory, so the operator does not refetch context each turn. The transport publishes the utterance and natural completion response after the agent finishes; direct operator chats follow the same completion-first order and reuse state from tool responses. It uses Codex's default model and ignores the user's CLI configuration as before. A direct CLI launch inherits the user's chosen model; during validation that CLI rejected the globally configured `gpt-6.1-sol` model. The MCP connection itself passed. This setup does not change user model settings.
