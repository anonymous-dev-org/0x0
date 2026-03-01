# @anonymous-dev/0x0-server

Core daemon for [0x0](https://github.com/anonymous-dev-org/0x0). Provides the HTTP API, session management, LLM provider bridges, tool execution, and all CLI commands except the TUI.

> **Note**: Most users don't interact with this package directly — the `0x0` TUI binary spawns the server automatically. This package is for headless/programmatic use or contributors.

## Prerequisites

- `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` environment variable (for Claude)
- Or the [Codex CLI](https://github.com/openai/codex) on PATH with `OPENAI_API_KEY` (for OpenAI)

## Quick Start

```bash
# Start the server directly (headless, no TUI)
0x0-server serve

# Run a one-shot message
0x0-server run "explain this codebase"
```

## Commands

| Command | Description |
|---------|-------------|
| `serve` (default) | Start the HTTP server on port 4096 |
| `acp` | Start ACP (Agent Client Protocol) server |
| `mcp` | Manage MCP (Model Context Protocol) servers |
| `run [message..]` | Run 0x0 with a message (headless) |
| `agent` | Manage agents |
| `models [provider]` | List available models |
| `stats` | Show token usage and cost statistics |
| `export [sessionID]` | Export session data as JSON |
| `import <file>` | Import shared data from URL or local file |
| `github` | Manage GitHub agent |
| `pr <number>` | Fetch and checkout a GitHub PR branch |
| `session` | Manage sessions |
| `upgrade [target]` | Upgrade 0x0 to latest or specific version |
| `uninstall` | Uninstall 0x0 and remove related files |
| `debug` | Debugging and troubleshooting tools |
| `generate` | Generate shell completion script |

## Architecture

```
src/
├── cli/          CLI command definitions
├── core/         Daemon lifecycle and installation
├── integration/  MCP, GitHub, ACP integrations
├── permission/   Permission system for tool access
├── project/      Project/workspace management
├── provider/     LLM provider bridges (claude-code, codex)
├── runtime/      Agent execution runtime
├── server/       Hono HTTP app, routes, mDNS
├── session/      Session management and message routing
├── tool/         Tool implementations (shell, file ops, search, web, etc.)
├── util/         Logging, errors, type helpers
└── workspace/    Workspace discovery and config
```

## Providers

- **claude-code** — Claude via `@anthropic-ai/claude-agent-sdk`
  - Models: `claude-sonnet-4-6` (default), `claude-opus-4-6`, `claude-haiku-4-5-20251001`
- **codex** — OpenAI Codex via `@openai/codex-sdk`
  - Models: `gpt-5-codex`, `o3`, `o4-mini`

## Exports

The package uses TypeScript source exports:

```json
{ "./*": "./src/*.ts" }
```

Other packages import directly from source:

```ts
import { Session } from "@anonymous-dev/0x0-server/session"
import { Log } from "@anonymous-dev/0x0-server/util/log"
```

## Development

```bash
bun run dev          # Start server in dev mode
bun test             # Run tests
bun run typecheck    # Type check with tsgo
bun run build        # Build binary
```
