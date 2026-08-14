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

- ✅ **Spike A** — headless engine runs end-to-end against any OpenAI/Anthropic-compatible gateway (see `spike-a` findings).
- ✅ **Spike B** — live event seam proven: a tiny injected plugin streams `reasoning-delta` / `tool-call-delta` / `text-delta` / tool cards / turn lifecycle in real time (`spike-b/`).
- 🚧 **TUI build** — in progress.

## Getting started

Prereqs: Node 20+, a running DeepSeek Harness install (`npx @deepseek-ai/dsh`), and an API key reachable via a provider configured in `~/.dsh/settings.yaml`.

```sh
# verify the headless engine works with your gateway
DEEPSEEK_API_KEY=sk-... npx @deepseek-ai/dsh --profile headless "run a test task"
```

## Project layout

```
spike-b/            # Spike B artifacts: live session streamer plugin + patch overlay
src/                # (in progress) the TUI plugin
profiles/           # (in progress) profile definitions
```

## License

MIT (matching DeepSeek Harness).
