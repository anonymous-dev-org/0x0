# @anonymous/claude-code-sdk

Internal wrapper around [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) used by the 0x0 server's Claude provider bridge.

## Purpose

This package provides a higher-level API on top of the raw Claude Agent SDK, handling:

- **Session lifecycle** — create, stream, and manage Claude Code sessions
- **Tool execution** — define tools and route tool calls back to the server
- **MCP integration** — bridge Model Context Protocol servers into Claude sessions
- **Feature flags** — startup context and feature flag resolution

## Exports

```ts
import {
  ClaudeCodeClient,
  ClaudeCodeSession,
  startup,
  McpSession,
} from "@anonymous/claude-code-sdk"
```

| Export | Description |
|--------|-------------|
| `ClaudeCodeClient` | HTTP client wrapper for the Claude Agent SDK |
| `ClaudeCodeSession` | Session lifecycle, message streaming, tool routing |
| `startup` | Feature flag resolution and initialization |
| `McpSession` | MCP server bridge for Claude sessions |
| `ApiError` | Error type for API failures |
| `McpRpcError` | Error type for MCP RPC failures |

## Usage

This package is internal — consumed by `packages/server/src/provider/sdk/claude-code/`. It is not published to npm.
