# dsh-tui

An interactive **terminal user interface (TUI)** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the coding agent harness that normally runs in a browser. `dsh-tui` gives you a Claude Code / Codex CLI-style terminal experience: live streaming, tool cards, reasoning disclosure, permission approvals, and session resume — all without opening a web page.

## Why

DeepSeek Harness ships two entry points:

| mode | what it is |
|---|---|
| `dsh web` | browser UI (the only shipped interactive surface) |
| `dsh --profile headless "task"` | one-shot: run a task, print the answer, exit |

Both are official. What's missing is the **interactive terminal middle ground** — the thing Claude Code does. The official team built one and cut it before open-sourcing (design notes remain in the repo's `.agents/notes/archived`), so the position is open.

`dsh-tui` fills it as a **plugin** on top of the harness's own plugin architecture: it boots the core agent directly (no HTTP, no browser), subscribes to the live `session/event` firehose, and renders a full-screen terminal UI.

## Status

- ✅ **Spike A** — headless engine runs end-to-end against any OpenAI/Anthropic-compatible gateway.
- ✅ **Spike B** — live event seam proven: a tiny injected plugin streams `reasoning-delta` / `tool-call-delta` / `text-delta` / tool cards / turn lifecycle in real time (`spike-b/`).
- ✅ **Approval seam** — bidirectional allow/deny round-trip verified without any web adapter (`approval-probe/`).
- ✅ **TUI core** — interactive multi-turn chat, live transcript, tool cards, reasoning, approval prompts (`dsh-tui/`). Line mode verified end-to-end; full-screen pi-tui UI ready for a real terminal.

## Running

Prereqs: Node 20+, a DeepSeek Harness install (`npx @deepseek-ai/dsh`), and a model provider configured in `~/.dsh/settings.yaml` (with the key available via its `apiKeyEnv`).

```sh
# interactive full-screen TUI (run in a real terminal)
npx @deepseek-ai/dsh --profile tui

# with an initial task
npx @deepseek-ai/dsh --profile tui "explain this repo"

# piped / non-TTY: line-mode REPL, or one-shot with a task
echo "list files" | npx @deepseek-ai/dsh --profile tui
npx @deepseek-ai/dsh --profile tui "list files" < /dev/null
```

The `tui` profile is created under `$DSH_HOME/profiles/tui` (see `dsh-tui/setup.mjs`) and mounts the local plugin. Commands inside the TUI: `/help`, `/resume` (pick a persisted session to continue), `/clear`, `/quit` (or Ctrl+C when idle), `/approve-test`, `/question-test`. Native harness commands (`/plan`, `/goal`, `/compact`, `/feedback`, `/permission`) dispatch through the official command plane.

### Native integration

`dsh-tui` runs in-process over `dsh-base`, so the entire official service surface is already live and rendered/controlled from the terminal:

- **Commands** — `/plan [msg]`, `/goal`, `/compact`, ... dispatch through `ctx.commands` (the official plane). Verified: `/plan` ↔ `/plan off` round-trip.
- **Questions** — a `ctx.userQuestions` provider lets the agent (and plan review via `exit_plan_mode`) ask you numbered options; answered with number keys (full-screen) or a number (line mode).
- **Approvals** — a `ctx.approval` answerer presents y/n prompts.
- **Events rendered** — plan/mode, goal/change, todo/write, subagent/descriptor, command/run, command/done, compaction, tool calls/results, streaming text, reasoning.
- **Resume** — `/resume` lists persisted sessions via `ctx.sessionQuery` and loads one with `agents.resume`.

## Project layout

```
spike-b/            # Spike B artifacts: live session streamer plugin + patch overlay
src/                # (in progress) the TUI plugin
profiles/           # (in progress) profile definitions
```

## License

MIT (matching DeepSeek Harness).
