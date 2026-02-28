import { Log } from "@/util/log"
import { Config } from "@/core/config/config"
import { PermissionNext } from "@/permission/next"
import { Session } from "@/session"
import type { Tool } from "@/tool/tool"
import { ClaudeCodeClient, ClaudeCodeSession } from "@anonymous/claude-code-sdk"
import type { ToolDefinition } from "@anonymous/claude-code-sdk"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"

const log = Log.create({ service: "claude-code" })

// ─── Session store ────────────────────────────────────────────────────────────
// Maps sessionId → { session, tools }. In-memory; lost on server restart.
// Storing tools avoids recomputing them on every resumed turn.
type SessionEntry = { session: ClaudeCodeSession; tools: ExecutableTool[] }
const sessions = new Map<string, SessionEntry>()

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getClient(): Promise<ClaudeCodeClient> {
  const config = await Config.get()
  const configKey = (config.provider?.["claude-code"] as { options?: { apiKey?: string } } | undefined)
    ?.options?.apiKey
  const token =
    configKey ??
    process.env.ANTHROPIC_OAUTH_TOKEN ??
    process.env.ANTHROPIC_API_KEY
  if (!token) {
    throw new Error(
      "claude-code provider requires ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN, " +
        "or configure provider.claude-code.options.apiKey in your config",
    )
  }
  return new ClaudeCodeClient({ oauthToken: token })
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type ClaudeEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "message-boundary" }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-input-delta"; id: string; partial: string }
  | { type: "tool-end"; id: string }
  | { type: "step-start" }
  | { type: "step-end" }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string }

export type ExecutableTool = {
  id: string
  description: string
  /** Already-converted JSON Schema object for the tool's input. */
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: Tool.Context) => Promise<{ output: string }>
}

export type ClaudeStreamInput = {
  modelId: string
  prompt: string
  systemPrompt?: string
  cliSessionId?: string
  abort: AbortSignal
  thinkingEffort?: string
  // Tool execution context (required when tools is non-empty)
  sessionID: string
  agentName: string
  agentPermission: PermissionNext.Ruleset
  tools: ExecutableTool[]
  canUseTool?: CanUseTool
}

// ─── Main stream function ─────────────────────────────────────────────────────

export async function* claudeStream(
  input: ClaudeStreamInput,
): AsyncGenerator<ClaudeEvent> {
  let client: ClaudeCodeClient
  try {
    client = await getClient()
  } catch (err) {
    yield { type: "error", message: String((err as { message?: string }).message ?? err) }
    return
  }

  // Reuse session if cliSessionId was returned from a previous turn
  const stored = input.cliSessionId ? sessions.get(input.cliSessionId) : undefined
  let session = stored?.session
  // On resume use cached tools; on new session use the ones passed in
  const activeTools = stored?.tools ?? input.tools

  if (!session) {
    const toolDefs: ToolDefinition[] = input.tools.map((t) => ({
      name: t.id,
      description: t.description,
      input_schema: t.inputSchema as ToolDefinition["input_schema"],
    }))

    session = new ClaudeCodeSession(client, {
      model: input.modelId,
      systemPrompt: input.systemPrompt,
      tools: toolDefs,
    })

    log.info("new session", {
      model: input.modelId,
      sessionId: session.sessionId,
      tools: input.tools.map((t) => t.id),
    })
  } else {
    log.info("resumed session", {
      model: input.modelId,
      sessionId: session.sessionId,
      cliSessionId: input.cliSessionId,
    })
  }

  yield { type: "step-start" }
  yield { type: "message-boundary" }

  const executor = buildExecutor(input, session, activeTools)

  try {
    for await (const event of session.send(input.prompt, executor, input.abort)) {
      switch (event.type) {
        case "text_delta":
          yield { type: "text-delta", text: event.delta }
          break

        case "thinking_delta":
          yield { type: "reasoning-delta", id: "thinking", text: event.delta }
          break

        case "tool_use_start":
          yield { type: "tool-start", id: event.toolUseId, name: event.toolName }
          break

        case "tool_use_input_delta":
          yield { type: "tool-input-delta", id: event.toolUseId, partial: event.partialJson }
          break

        case "tool_use_done":
          // Input streaming complete — tool is about to execute (tool-end fires after tool_result)
          break

        case "tool_result":
          // Tool executed; signal completion
          yield { type: "tool-end", id: event.toolUseId }
          // New inference turn: emit message-boundary so UI finalises previous text
          yield { type: "message-boundary" }
          break

        case "done":
          // Persist session + tools for resumption on the next user turn
          sessions.set(session.sessionId, { session, tools: activeTools })
          yield { type: "step-end" }
          yield { type: "done", sessionId: session.sessionId }
          break
      }
    }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      // Remove the session — a mid-turn API error leaves history in an
      // inconsistent state (tool_use with no matching tool_result). Resuming
      // it would cause an immediate API error on the next call.
      sessions.delete(session.sessionId)
      yield { type: "error", message: String(e?.message ?? err) }
    }
  }
}

function buildExecutor(
  input: ClaudeStreamInput,
  session: ClaudeCodeSession,
  tools: ExecutableTool[],
): (toolName: string, toolInput: Record<string, unknown>) => Promise<string> {
  const messageID = `bridge-${session.sessionId}`
  return async (toolName: string, toolInput: Record<string, unknown>) => {
    // 1. Permission gate (CanUseTool requires signal + toolUseID)
    const callID = crypto.randomUUID()
    if (input.canUseTool) {
      const perm = await input.canUseTool(toolName, toolInput, {
        signal: input.abort,
        toolUseID: callID,
      })
      if (perm.behavior === "deny") {
        throw new Error(perm.message ?? `Tool "${toolName}" denied by permission policy`)
      }
      toolInput = perm.updatedInput ?? toolInput
    }

    // 2. Find the tool
    const toolInfo = tools.find((t) => t.id === toolName)
    if (!toolInfo) {
      throw new Error(`Tool "${toolName}" not found. Available: ${tools.map((t) => t.id).join(", ")}`)
    }

    // 3. Build Tool.Context for this call (reuse callID from permission gate)
    const ctx: Tool.Context = {
      sessionID: input.sessionID,
      messageID,
      agent: input.agentName,
      abort: input.abort,
      callID,
      messages: [],
      metadata: () => {},
      ask: async (req) => {
        const session = await Session.get(input.sessionID).catch(() => null)
        await PermissionNext.ask({
          ...req,
          sessionID: input.sessionID,
          tool: { messageID, callID },
          ruleset: PermissionNext.merge(input.agentPermission, session?.permission ?? []),
        })
      },
    }

    // 4. Execute
    const result = await toolInfo.execute(toolInput, ctx)
    return result.output
  }
}

// ─── Completion stream (non-agentic, single turn) ─────────────────────────────

export type CompletionEvent =
  | { type: "delta"; text: string }
  | { type: "error"; error: string }
  | { type: "done" }

export async function* completionStream(input: {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
  abort?: AbortSignal
}): AsyncGenerator<CompletionEvent> {
  let client: ClaudeCodeClient
  try {
    client = await getClient()
  } catch (err) {
    yield { type: "error", error: String((err as { message?: string }).message ?? err) }
    return
  }

  const session = new ClaudeCodeSession(client, {
    model: input.model,
    systemPrompt: input.systemPrompt,
    disableThinking: true,
  })

  log.info("starting completion stream", { model: input.model })

  try {
    let done = false
    for await (const event of session.send(input.prompt, undefined, input.abort)) {
      if (done) break

      if (event.type === "text_delta") {
        let text = event.delta
        if (input.stopSequences?.length) {
          for (const stop of input.stopSequences) {
            const idx = text.indexOf(stop)
            if (idx !== -1) {
              text = text.slice(0, idx)
              if (text) yield { type: "delta", text }
              yield { type: "done" }
              done = true
              break
            }
          }
          if (done) break
        }
        if (text) yield { type: "delta", text }
      }
    }
    if (!done) yield { type: "done" }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      yield { type: "error", error: String(e?.message ?? err) }
    }
  }
}
