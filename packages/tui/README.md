# 0x0

Terminal UI for [0x0](https://github.com/anonymous-dev-org/0x0). This is the `0x0` binary that users install and interact with. Built with [OpenTUI](https://github.com/opentui/opentui) and Solid.js for reactive terminal rendering.

## Quick Start

```bash
# Install
npm i -g @anonymous-dev/0x0@latest   # or: brew install 0x0

# Set your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Launch
0x0
```

The TUI spawns a background server on port 4096 (if one isn't already running), connects to it, and you're ready to go. The server persists after the TUI exits — subsequent launches reconnect instantly.

To use OpenAI Codex instead of Claude, install the [Codex CLI](https://github.com/openai/codex) and set `OPENAI_API_KEY`.

## Commands

| Command | Description |
|---------|-------------|
| `0x0 [project]` (default) | Start the TUI |
| `0x0 attach <url>` | Attach to a running 0x0 server |
| `0x0 server` | Start a headless server (alias: `serve`) |

All server commands (`run`, `mcp`, `agent`, `models`, `stats`, `export`, `import`, `github`, `pr`, `session`, `upgrade`, `uninstall`, `debug`) are re-exported from `@anonymous-dev/0x0-server`.

## Architecture

The TUI package is intentionally thin. It owns:

```
src/
├── daemon/   Daemon lifecycle (discover, start, stop on port 4096)
├── tui/      OpenTUI + Solid.js terminal UI components
└── index.ts  CLI entry — TUI commands + lazy re-exports of server commands
```

Everything else (sessions, providers, tools, HTTP API) lives in the [server](../server/) package.

## How It Works

1. On launch, checks if a server is already running on port 4096
2. If not, spawns `0x0-server` as a background daemon
3. Connects to the server via HTTP and SSE for real-time events
4. Renders the interactive terminal UI (prompt, messages, file trees, diffs)
5. The server persists after the TUI exits

## Development

```bash
bun run dev          # Start TUI in dev mode (with browser conditions for Solid.js)
bun test             # Run tests
bun run typecheck    # Type check with tsgo
bun run build        # Build binary (Solid.js plugin + browser conditions)
```
