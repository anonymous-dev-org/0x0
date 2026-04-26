# ACP Agent Runtime Plan

## Goal

Use Agent Client Protocol adapters for the coding-agent runtime instead of building a custom model/tool harness in this server.

For this repo, that means:

- `codex` launches an ACP-compatible Codex adapter, preferably `codex-acp`.
- `claude` launches `claude-agent-acp`.
- The 0x0 server becomes the local ACP client/host for Neovim, not the primary agent implementation.
- Existing Neovim plugins continue talking to 0x0 over HTTP/WebSocket.
- 0x0 maps editor requests into ACP sessions and maps ACP updates back into the current UI contract.

This replaces the earlier plan to own provider-native model calls, tool execution, sandboxing, and prompt loops in `apps/server`.

## Why

ACP is the right boundary for this product because 0x0 is an editor-facing agent host. The protocol already covers the hard parts we were starting to rebuild:

- Agent subprocess lifecycle over JSON-RPC/stdio.
- Initialization, authentication, session creation, prompt turns, and cancellation.
- Streaming session updates for assistant text, thinking, tool calls, plans, and command availability.
- Client-side permission requests.
- Client-exposed filesystem and terminal capabilities.
- Session modes and resumable sessions where the adapter supports them.

Using ACP lets Claude Code and Codex keep their own agent loops while 0x0 owns the Neovim UX, session list, review flow, provider selection, and local policy.

## Non-Goals

- Do not build a competing provider-native tool loop in V1.
- Do not expose arbitrary third-party MCP mutation tools through 0x0.
- Do not make Neovim speak ACP directly in V1.
- Do not remove the simple one-shot `/completions` and `/inline-edit` paths until ACP parity is proven.
- Do not depend on provider-hosted web UIs or browser automation.

## Current Server Shape

The server now has one ACP-backed provider implementation:

- `src/providers/acp.ts` manages adapter subprocesses over ACP stdio JSON-RPC.
- Provider `codex` launches `codex-acp`.
- Provider `claude` launches `claude-agent-acp`.
- Interactive `/ws` chat uses one ACP session per 0x0 session.
- `/completions` and `/inline-edit` use short-lived ACP sessions for now.
- `src/agent/tools.ts` contains first-party inspect/edit/execute tools.
- `/ws` owns chat sessions, worktree sync, change status, accept, and discard.

Keep the API surface that Neovim already uses while the implementation behind providers is ACP subprocess sessions.

## Target Architecture

```txt
Neovim plugins
  -> 0x0 HTTP/WebSocket API
    -> AcpClientSession
      -> stdio JSON-RPC subprocess
        -> codex-acp or claude-agent-acp
          -> Codex CLI / Claude Agent SDK runtime
```

0x0 remains the stable local service. ACP adapters are child processes managed per provider/session.

### 0x0 Responsibilities

- Provider discovery and configuration.
- Starting and stopping ACP adapter subprocesses.
- ACP `initialize`, optional `authenticate`, `session/new`, `session/load`, `session/prompt`, and `session/cancel`.
- Mapping ACP `session/update` notifications into 0x0 WebSocket events.
- Handling ACP permission requests with explicit Neovim/user-facing prompts.
- Providing client capabilities to ACP agents only when we deliberately support them.
- Preserving existing review primitives: changed files, accept/discard, and file-level review.
- Keeping stateless completion and selected-hunk edit endpoints available while the ACP path matures.

### ACP Adapter Responsibilities

- Model selection and provider authentication.
- Agent prompt/tool loop.
- Tool-call formatting and progress semantics.
- Claude Code/Codex-specific behavior.
- Adapter-native session state and resume support.

## Provider Configuration

Represent providers as launchable ACP agents instead of direct SDK adapters:

```ts
type AcpProviderConfig = {
  id: "codex" | "claude"
  label: string
  command: string
  args: string[]
  defaultModel?: string
  models?: string[]
  env?: Record<string, string>
}
```

Initial defaults:

```ts
{
  id: "codex",
  label: "Codex",
  command: "codex-acp",
  args: []
}
```

```ts
{
  id: "claude",
  label: "Claude Code",
  command: "claude-agent-acp",
  args: []
}
```

The server should check command availability at startup and expose unavailable providers through `/providers` with a clear reason.

## API Compatibility

Keep the existing 0x0 API names where possible:

```txt
GET /health
GET /providers
GET /ws
POST /messages
POST /completions
POST /inline-edit
```

For `/ws`:

- `session.create` creates an ACP session.
- `chat.turn` sends `session/prompt`.
- `run.cancel` sends `session/cancel`.
- ACP `session/update` becomes the existing assistant/status/tool update event stream.
- ACP prompt completion becomes `assistant.done`.

For review:

- Prefer adapter-reported file updates if available.
- Fall back to 0x0-owned Git diff/status against the repo/worktree.
- Keep accept/discard as 0x0 server actions, not ACP agent actions.

For one-shot endpoints:

- Use short-lived ACP sessions.
- Revisit latency and output control after real adapter smoke tests can run outside the sandbox.

## Session And Worktree Policy

V1 should use one ACP session per 0x0 session.

Use a real working directory for each session:

- Existing repo root for read-only or direct-edit modes.
- 0x0-managed worktree for proposal/review mode.

Default to proposal/review mode for coding-agent chat:

1. Create or sync a 0x0 worktree.
2. Start the ACP adapter with that worktree as the session root.
3. Let the adapter edit inside that worktree.
4. Compute changed files with Git.
5. Present review and accept/discard through 0x0.

This preserves the editor review workflow without forcing every adapter to know about 0x0's Git refs.

## Permission Model

ACP agents can request permissions from the client. 0x0 should treat those requests as policy boundaries, not passive UI events.

Initial policy:

- Read-only file access can be auto-approved inside the session root.
- File writes are allowed only inside the session worktree.
- Terminal execution requires explicit approval unless the command matches a narrow allowlist.
- Destructive filesystem and Git commands require explicit approval.
- External network access is denied by default unless the provider adapter owns it internally.
- Permission decisions should be logged in the session event stream.

The Neovim UI can start with simple approve/deny prompts, then later add per-session mode controls.

## Event Mapping

Map ACP updates into 0x0 events without leaking protocol-specific details into the Lua UI.

Suggested mapping:

```txt
ACP assistant/user/thought chunks -> assistant.delta or run.status
ACP tool call/update             -> tool.started/tool.updated/tool.done
ACP plan update                  -> plan.updated
ACP available commands           -> commands.updated
ACP permission request           -> permission.requested
ACP mode update                  -> session.mode.updated
ACP prompt response              -> assistant.done
ACP JSON-RPC error               -> error
```

Thinking should remain status-like metadata, not visible assistant transcript text.

## Implementation Slices

1. Done: install `@agentclientprotocol/sdk`, `@zed-industries/codex-acp`, and `@agentclientprotocol/claude-agent-acp`.
2. Done: replace provider-native SDK adapters with `AcpProvider`.
3. Done: replace interactive `/ws` provider execution with ACP session prompts.
4. Done: preserve `/providers` while reporting ACP command availability.
5. Done: map assistant chunks, thought chunks, and tool-call updates into the current WebSocket event stream.
6. Done: remove the custom `src/agent/runner.ts` harness and direct Codex/Claude SDK providers.
7. Partial: permission requests are handled through ACP, currently auto-selecting the safest allow option available.
8. Next: add explicit Neovim permission request events and approval responses.
9. Next: add richer ACP event mapping for plan, command, mode, config, and usage updates.
10. Next: run Codex and Claude prompt-turn smoke tests outside the sandbox.

## Migration Order

Codex and Claude now share the same provider class. The remaining migration work is UI/protocol polish rather than runtime replacement.

## Open Questions

- Should 0x0 store ACP session IDs and adapter metadata in its existing session store?
- How much of ACP filesystem and terminal capability should 0x0 implement directly versus letting adapters use their own tools?
- Should permission approvals be persisted per session, per repo, or never persisted in V1?
- Can `claude-agent-acp` run cleanly from the user's current Claude Code auth state without extra config?
- Can Codex ACP use the user's ChatGPT auth flow, or should 0x0 require API-key auth for predictability?

## Sources Checked

- ACP architecture: https://agentclientprotocol.com/get-started/architecture
- ACP protocol overview: https://agentclientprotocol.com/protocol/overview
- ACP transports: https://agentclientprotocol.com/protocol/transports
- ACP agent list: https://agentclientprotocol.com/get-started/agents
- ACP GitHub organization and SDK list: https://github.com/agentclientprotocol
- Claude ACP adapter: https://github.com/agentclientprotocol/claude-agent-acp
- Agentic.nvim ACP client reference: `agentic.nvim/lua/agentic/acp/acp_client.lua`
