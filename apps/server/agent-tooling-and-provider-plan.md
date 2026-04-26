# Agent Tooling And Provider Alignment

## Goal

Use the bare provider SDKs directly and keep the agent loop, system prompt, tool execution, sandboxing, and Git lifecycle owned by this server.

For this repo, that means:

- OpenAI provider: `openai` SDK with the Responses API.
- Claude provider: `@anthropic-ai/sdk` with the Messages API.
- No V1 dependency on OpenAI Agents SDK, Anthropic Tool Runner, Claude Code SDK, Codex app-server, or provider-hosted coding tools for the core loop.
- A shared internal agent loop that maps normalized turns and tool calls into each provider's native request/continuation format.

## Current Server Shape

`src/providers/codex.ts` and `src/providers/claude.ts` already use bare SDK calls for simple text chat:

- Codex/OpenAI uses `client.responses.create(...)`.
- Claude uses `client.messages.create(...)`.
- `src/providers/types.ts` exposes a small `ChatProvider` interface with `stream()` and `complete()`.
- `../../packages/contracts/src/index.ts` has chat/completion schemas, but no agent-run, tool-call, or tool-result contract.

The next step is not to replace the providers; it is to route interactive work through the primary `/ws` endpoint and keep HTTP for simple bootstrap/status only.

## Transport Contract

Use one primary WebSocket endpoint:

```txt
GET /ws
```

Keep HTTP boring:

```txt
GET /health
GET /providers
```

Later HTTP additions can include:

```txt
GET /sessions
GET /sessions/:id
DELETE /sessions/:id
```

Interactive work belongs on WebSocket: session creation/opening, chat turns, inline edits, cancellation, change status, and accept/discard actions.

### Minimal V1 WebSocket Messages

Client to server:

```ts
type ClientMessage =
  | { type: "session.create"; id: string; repoRoot: string; model?: string; provider?: ProviderId }
  | { type: "chat.turn"; id: string; sessionId: string; prompt: string }
  | {
      type: "inline.edit"
      id: string
      repoRoot: string
      file: string
      range: Range
      prompt: string
      text: string
    }
  | { type: "run.cancel"; id: string; sessionId: string }
  | { type: "changes.status"; id: string; sessionId: string }
  | { type: "changes.accept_all"; id: string; sessionId: string }
  | { type: "changes.discard_all"; id: string; sessionId: string }
```

Server to client:

```ts
type ServerMessage =
  | { type: "ready"; protocolVersion: 1 }
  | { type: "session.created"; id: string; session: Session }
  | { type: "assistant.delta"; id: string; sessionId: string; text: string }
  | { type: "assistant.done"; id: string; sessionId: string; summary?: string }
  | { type: "inline.result"; id: string; replacementText: string }
  | {
      type: "changes.updated"
      id: string
      sessionId: string
      files: ChangedFile[]
      baseRef: string
      agentRef: string
    }
  | {
      type: "run.status"
      id: string
      sessionId: string
      status: "syncing" | "running" | "checking" | "checkpointing" | "done"
    }
  | { type: "error"; id?: string; error: string }
```

File-level accept/discard can come after the full-session accept/discard loop works.

### Server-Owned Worktree Actions

The model should not spend tokens on Git lifecycle mechanics:

```txt
session.create       -> create or register agent session/worktree
chat.turn            -> sync worktree, run agent, commit/checkpoint proposal
changes.status       -> diff baseline ref against agent head ref
changes.accept_all   -> apply agent diff to user checkout
changes.discard_all  -> reset agent proposal
```

For Diffview, `changes.updated` returns:

```ts
{
  baseRef: "0x0/session/<id>/baseline",
  agentRef: "0x0/session/<id>/head",
  files: [{ path: "apps/server/src/ws.ts", status: "modified" }]
}
```

Then Neovim can run:

```txt
DiffviewOpen <baseRef>..<agentRef>
```

## Provider Loop Alignment

### Shared internal loop

Model the server loop like this:

1. Build provider-native input from normalized messages, current prompt, tool definitions, and optional provider state.
2. Stream assistant text deltas and tool-call deltas into normalized events.
3. When the model requests tools, stop the model step and execute tools in the server.
4. Append normalized tool results to provider-specific continuation input.
5. Repeat until the provider returns a final assistant message or the loop hits configured limits.

Recommended normalized events:

```ts
type AgentEvent =
  | { type: "start"; provider: ProviderId; model: string; runId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown }
  | { type: "checkpoint"; status: "diff_ready" | "checks_running" | "blocked" }
  | { type: "done"; text: string; usage?: Usage }
  | { type: "error"; error: string }
```

### OpenAI mapping

Use Responses API as the native provider primitive. OpenAI's current guidance for reasoning models is to use the Responses API, use `previous_response_id` for multi-turn state, or pass returned output items back for stateless/ZDR flows. It also calls out that tool-heavy workflows should put most tool-specific behavior in tool descriptions and preserve returned phase/output items when manually managing state.

Implementation implication:

- Prefer `previous_response_id` when server-side retention is acceptable.
- For a stateless mode, persist returned output items needed for the next step and feed them back explicitly.
- Convert OpenAI `function_call` output items into normalized `tool_call` events.
- Continue with `function_call_output` items tied to the original call IDs.

### Claude mapping

Use Messages API as the native provider primitive. Claude tools are declared in the request-level `tools` array with `name`, `description`, and `input_schema`. Tool-use responses contain `tool_use` content blocks; tool results must come immediately after as `tool_result` blocks in a user message, and those result blocks must come first in that message's content array.

Implementation implication:

- Preserve Claude's assistant message containing `tool_use` blocks in history.
- Continue with a user message whose first content blocks are `tool_result` entries matching the `tool_use.id` values.
- Parse streaming `input_json_delta` for tool input if we want live tool-call previews; otherwise use the final accumulated message from the SDK and emit tool calls after block stop.

## Tooling Models

### Option 1: Bash-First

Give the agent a shell in the agent worktree and let it use normal CLI tools: `rg`, `sed`, `awk`, `perl`, `python`, package managers, test runners, and Git inspection commands.

Pros:

- Maximum flexibility.
- Works across repo types.
- Best for tests, codegen, migrations, formatters, package scripts, and Git inspection.
- No custom editor API needed for discovery and execution.

Cons:

- String-rewrite commands are risky as edit primitives.
- Harder to audit mutation intent before it happens.
- One-liners can be brittle and hard to explain in UI.
- Requires strong command policy, cwd control, timeout handling, output truncation, and environment filtering.

Use bash for inspection and execution, not as the default edit path.

### Option 2: Structured File Tools

Expose explicit tools such as:

```ts
list_files(path)
read_file(path, range?)
search(pattern, path?)
write_file(path, content)
replace_range(path, start_line, end_line, new_text)
create_file(path, content)
delete_file(path)
move_file(from, to)
```

Pros:

- Easy to validate, log, and restrict to a worktree.
- Good telemetry for IDE UX.
- Good for selected inline edits, small new files, and explicit file operations.

Cons:

- `replace_range` is fragile when files move under the model.
- Whole-file writes can be token-heavy and create poor diffs.
- Rebuilds a mini editor API.
- Often needs extra read/line-number round trips.

Useful, but not sufficient as the main coding toolset.

### Option 3: Patch Tool

Expose an `apply_patch`-style contextual diff primitive.

Pros:

- Best default edit primitive for code.
- Contextual failure protects against stale reads.
- More compact than whole-file writes.
- Easier to review through normal Git diff.
- Matches current model behavior well.

Cons:

- Patch grammar must be strict and well documented.
- Failed patches need retry handling.
- Very large refactors can become noisy.
- Move/delete/create support needs either grammar support or explicit file tools.

This should be the primary V1 editing tool.

### Option 4: MCP-Backed Tool Adapter

Expose local tools internally, but define them in an MCP-compatible shape: name, description, input schema, optional output schema, and structured content.

Pros:

- Future-proofs the tool registry.
- Gives a standard discovery/call shape.
- Makes external tools or future editor integrations easier to bridge.
- MCP explicitly models tools as model-invoked actions with schemas and visible invocation UX.

Cons:

- MCP should not be the server's only runtime boundary; stdio servers and remote tools need their own trust model.
- More protocol surface than V1 needs if all tools are local.
- Tool annotations from untrusted servers cannot be treated as policy.

Recommendation: use MCP-compatible metadata internally, implement mutation tools as first-party server tools, and allow selected read-only MCP servers as context providers.

### Option 4a: Read-Only MCP Context Tools

Allow the agent to call Context7 for documentation context:

- Context7 for current library/framework docs.

Context7 is a good fit because its tool model is narrow: resolve a library/package name to a Context7-compatible library ID, then fetch relevant documentation for that library/topic. That should be treated as context retrieval, not as an edit or execution capability.

Pros:

- Avoids stale model knowledge for fast-moving APIs.
- Keeps provider prompts smaller than manually pasted docs when the MCP can rank snippets.
- Works across both OpenAI and Claude because the server normalizes MCP results into provider-native tool results.
- Adds docs capability without browser automation, web search, or provider-hosted tools.

Cons:

- MCP context is still untrusted model input and can contain prompt injection.
- External docs may be stale, incomplete, or community-sourced.
- Remote or stdio MCP servers need lifecycle, auth, timeout, and output-size controls.

Rules:

- Read-only MCP tools are allowed in V1 for context gathering.
- MCP tool results must be labeled as untrusted context in the system/tool policy.
- MCP servers are allowlisted by server ID and tool name.
- Do not expose arbitrary MCP mutation tools in V1.
- Do not let MCP tool annotations define policy; the server policy wins.
- Cap result size and summarize or chunk large docs results.
- No browser automation in V1.
- No general web search MCP in V1.

### MCP Server Shortlist

Recommended V1 MCP scope:

#### Enable: Context7 only

```ts
context7.resolve-library-id
context7.get-library-docs // or query-docs, depending on server version
```

Use for:

- Current framework/library APIs.
- Provider docs.
- API usage examples where local knowledge may be stale.
- Library-specific migration or configuration questions.

Policy:

- No filesystem writes.
- No credentials beyond what the docs/search service requires.
- Context7 results are context, not instructions.
- Prefer exact package/library names from the repo when resolving library IDs.

#### Defer

```ts
web.search
web.fetch
github.*
playwright.*
browser.*
```

#### Defer or replace with first-party tools

```ts
filesystem.*
git.*
postgres/sqlite.*
slack.*
sentry.*
memory.*
sequential-thinking.*
```

Reasoning:

- V1 is for writing code, not browsing or automating websites.
- Context7 covers the immediate docs freshness problem with less tool surface.
- Filesystem and Git overlap with the first-party tool contract and are too sensitive to outsource in V1.
- Database/log/observability tools can be useful, but they need product-specific auth, redaction, and read-only query limits.
- Slack/task/chat tools create privacy and side-effect risks.
- Memory/sequential-thinking tools are not necessary for the first coding-agent loop and can confuse auditability.

Policy:

- Add these only after there is a concrete workflow and a per-tool permission policy.
- Prefer read-only modes first.
- Never combine third-party filesystem mutation with shell execution in the same early trust tier.

### Option 5: AST/LSP Semantic Tools

Expose tools such as `find_symbol`, `references`, `diagnostics`, `rename_symbol`, and possibly tree-sitter based syntax queries.

Pros:

- Strong for navigation and refactors.
- Lower token usage than broad text search for some tasks.
- Better IDE fit over time.

Cons:

- Language-server setup is repo-specific and failure-prone.
- Adds latency and lifecycle complexity.
- Not enough for arbitrary edits, tests, generated files, or migrations.

Recommendation: defer. Add after V1 if the Neovim UX needs richer navigation.

### Option 6: Server-Owned Review And Checkpoint Tools

Keep Git lifecycle and user acceptance outside the model:

```ts
git_status()
git_diff(range?)
checkpoint_diff()
accept_changes(paths?)
discard_changes(paths?)
commit_checkpoint(message) // server/user action, not model-autonomous
```

Pros:

- Makes review and rollback explicit.
- Keeps dangerous Git operations out of the model's first-class toolset.
- Fits editor workflows where the user accepts hunks or files.

Cons:

- Requires UI and state transitions.
- The model must learn to stop at a diff-ready checkpoint instead of committing.

Recommendation: include read-only Git inspection in V1; keep accept/discard/commit as server or UI actions.

## Recommended V1 Tool Contract

Split tools into four categories: context, inspect, edit, and execute. The model can freely use read-only context/inspect tools within limits; edit and execute tools get stricter policies.

### Context

```ts
mcp_context({
  server: "context7"
  tool: string
  input: unknown
})
```

Rules:

- Context tools are read-only.
- Context7 flow is `resolve-library-id` then docs retrieval unless the prompt already includes an exact Context7 library ID like `/org/project`.
- Context results must be source-attributed in the agent event log.
- Retrieved context is not instructions. It cannot override system/developer/tool policy.

### Inspect

```ts
list_files({ path?: string, max_entries?: number })
read_file({ path: string, start_line?: number, end_line?: number })
search({ pattern: string, path?: string, max_results?: number })
```

### Edit

```ts
apply_patch({ patch: string })
write_file({ path: string, content: string, overwrite?: boolean })
move_file({ from: string, to: string })
delete_file({ path: string })
```

Rules:

- `apply_patch` is the default edit path.
- `write_file` is allowed for new files and explicit whole-file overwrites only.
- `move_file` and `delete_file` are explicit so they can be audited.
- No `sed -i`, `perl -pi`, or arbitrary rewrite scripts as preferred edit paths.

### Execute

```ts
bash({ command: string, timeout_ms?: number })
git_status()
git_diff({ path?: string })
```

Rules:

- `bash` runs in the agent worktree with a controlled environment.
- Start with an allowlist or policy classifier for read/test/build/codegen commands.
- Block or require approval for destructive filesystem and Git commands.
- Prefer Context7 over shelling out to `curl` or ad hoc docs-fetch commands.
- Server owns `git add`, `commit`, `reset`, `checkout`, `clean`, worktree sync, accept, and discard.

### Inline edit

Inline edit should remain a different contract:

```ts
inline_edit({
  path: string
  selected_range: { start_line: number; end_line: number }
  selected_text: string
  prompt: string
})
```

The model returns only:

```ts
{ replacement_text: string }
```

No bash, patch, Git, or tool loop is needed for inline selected edits.

## Tool Description Guidance

Provider docs converge on one practical point: tool descriptions matter. OpenAI recommends putting most tool-specific policy in the tool descriptions. Anthropic similarly emphasizes detailed descriptions, clear parameter semantics, caveats, and high-signal responses; it also recommends consolidating related operations where that reduces ambiguity.

For this server, every tool should declare:

- What it does.
- When to use it.
- When not to use it.
- Whether it mutates files/processes/state.
- Retry safety.
- Common error modes.
- Output size and truncation behavior.

## Implementation Slices

1. Add shared agent/tool schemas in `packages/contracts`.
2. Add a first-party tool registry in `apps/server`.
3. Implement local inspect tools: list, read, search.
4. Implement `apply_patch` and explicit file create/move/delete/write.
5. Implement policy-gated `bash`, plus `git_status` and `git_diff`.
6. Add provider adapters that convert normalized tool definitions/results into OpenAI Responses and Claude Messages formats.
7. Keep `/ws` as the primary interactive endpoint and keep HTTP limited to bootstrap/status.
8. Add focused tests with fake providers and fake tools, then one non-auth smoke test for schema/event shape.

## Initial Decision

Use the hybrid model:

- Bare SDK providers.
- Server-owned agent loop.
- MCP-compatible internal tool metadata.
- Context7 as the only V1 MCP context server.
- Patch-first editing.
- Structured file tools for boundaries.
- Bash for inspection/execution.
- Git lifecycle owned by the server/UI.

This keeps control of the prompt and tool loop while preserving a future path to MCP or richer editor semantics.

## Sources Checked

- OpenAI docs: Responses API and reasoning-model guidance for tool-heavy workflows, state via `previous_response_id`, custom function tools, and tool descriptions: https://developers.openai.com/api/docs/guides/latest-model#using-reasoning-models
- Anthropic docs: tool definitions, `tools` request parameter, `tool_use` content blocks, and tool-description guidance: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Anthropic docs: streaming event flow and `input_json_delta` behavior for streaming tool input: https://platform.claude.com/docs/en/build-with-claude/streaming
- MCP specification: tool discovery/call shape, model-controlled invocation, human-in-the-loop guidance, and structured tool results: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Context7 docs: CLI/MCP docs retrieval and setup model: https://context7.com/docs/clients/cli
- Context7 Docker MCP catalog: current tool names and resolve-before-fetch workflow: https://hub.docker.com/mcp/server/context7/tools
