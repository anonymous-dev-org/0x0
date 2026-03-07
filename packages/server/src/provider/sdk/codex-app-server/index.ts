import { resolveCodexBinary } from "@/provider/resolve-codex-binary"
import type { Agent } from "@/runtime/agent/agent"
import { type BridgeContext, registerBridge, unregisterBridge } from "@/server/routes/tool-bridge"
import { Server } from "@/server/server"
import { ToolRegistry } from "@/tool/registry"
import { Log } from "@/util/log"

const log = Log.create({ service: "codex-app-server" })

export type CodexEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "tool-start"; id: string; tool: string; command?: string }
  | { type: "tool-output"; id: string; output: string }
  | { type: "tool-end"; id: string; output: string; exitCode?: number }
  | { type: "file-change"; id: string; files: Array<{ path: string; kind: string }> }
  | { type: "step-start" }
  | { type: "step-end" }
  | { type: "done"; threadId: string }
  | { type: "error"; message: string }

export type CodexStreamInput = {
  modelId: string
  prompt: string
  systemPrompt?: string
  threadId?: string
  abort: AbortSignal
  cwd?: string
  sessionID: string
  agentName: string
  agent: Agent.Info
}

type StreamEvent = {
  type?: unknown
  thread_id?: unknown
  error?: { message?: unknown } | null
  message?: unknown
  item?: {
    id?: unknown
    type?: unknown
    text?: unknown
    command?: unknown
    aggregated_output?: unknown
    exit_code?: unknown
    changes?: Array<{ path?: unknown; kind?: unknown }>
    server?: unknown
    tool?: unknown
    arguments?: unknown
    result?: unknown
    status?: unknown
    query?: unknown
    error?: { message?: unknown } | null
  } | null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function isPolicyRestrictedItem(type: string): boolean {
  return type === "command_execution" || type === "file_change" || type === "web_search"
}

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatMcpResult(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const rec = result as { content?: unknown; structured_content?: unknown }
  const content = Array.isArray(rec.content) ? rec.content : []
  const textBlocks: string[] = []

  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const maybeText = (block as { text?: unknown }).text
    if (typeof maybeText === "string" && maybeText.trim()) {
      textBlocks.push(maybeText)
    }
  }

  if (textBlocks.length > 0) return textBlocks.join("\n")
  return stringifyUnknown(rec.structured_content ?? result)
}

function isAuthErrorMessage(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("not authenticated") ||
    m.includes("authentication") ||
    m.includes("login required")
  )
}

export function composeCodexTurnInput(prompt: string, systemPrompt?: string): string {
  const sys = (systemPrompt ?? "").trim()
  if (!sys) return prompt
  return ["<system-instructions>", sys, "</system-instructions>", "", prompt].join("\n")
}

export function normalizeCodexErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : stringifyUnknown(error)
  const fallback = message || "Unknown Codex error"
  if (isAuthErrorMessage(fallback)) {
    return 'Codex CLI is not authenticated. Run "codex login" and retry.'
  }
  return fallback
}

export async function* codexAppServerStream(input: CodexStreamInput): AsyncGenerator<CodexEvent> {
  const textByItem = new Map<string, string>()
  const outputByItem = new Map<string, string>()
  const mcpArgsSeen = new Set<string>()
  const abortController = new AbortController()

  if (input.abort.aborted) return
  const onAbort = () => abortController.abort()
  input.abort.addEventListener("abort", onAbort, { once: true })

  // Register MCP tool bridge — same mechanism as Claude Code
  const bridgeId = crypto.randomUUID()
  const serverUrl = Server.url()
  const cwd = input.cwd ?? process.cwd()
  const mcpUrl = `${serverUrl.origin}/tool-bridge/${bridgeId}?directory=${encodeURIComponent(cwd)}`

  const rawTools = await ToolRegistry.tools({ providerID: "codex", modelID: input.modelId }, input.agent)
  const bridgeTools: BridgeContext["tools"] = rawTools.map(t => ({
    id: t.id,
    description: t.description,
    parameters: t.parameters,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any, ctx: any) => t.execute(args, ctx),
  }))

  registerBridge(bridgeId, {
    sessionID: input.sessionID,
    agentName: input.agentName,
    agent: input.agent,
    abort: input.abort,
    tools: bridgeTools,
  })

  try {
    const codexPath = resolveCodexBinary()
    if (!codexPath) {
      yield { type: "error", message: "Codex CLI binary not found. Install @openai/codex or add codex to your PATH." }
      return
    }

    // Dynamic import: avoids top-level createRequire(import.meta.url) in compiled binaries
    let CodexClass: typeof import("@openai/codex-sdk").Codex
    try {
      const mod = await import("@openai/codex-sdk")
      CodexClass = mod.Codex
    } catch (importErr) {
      const msg = importErr instanceof Error ? importErr.message : String(importErr)
      yield { type: "error", message: `Failed to load @openai/codex-sdk: ${msg}` }
      return
    }

    let codex: InstanceType<typeof CodexClass>
    try {
      codex = new CodexClass({
        codexPathOverride: codexPath,
        config: {
          include_apply_patch_tool: false,
          tools_web_search: false,
          tools_view_image: false,
          web_search: "disabled",
          features: {
            shell_tool: false,
          },
          mcp_servers: {
            tools: {
              url: mcpUrl,
              tool_timeout_sec: 600, // 10 min — question tool needs long-lived connections
            },
          },
        },
      })
    } catch (ctorErr) {
      const msg = ctorErr instanceof Error ? ctorErr.message : String(ctorErr)
      yield { type: "error", message: `Failed to initialize Codex SDK (codexPath=${codexPath}): ${msg}` }
      return
    }

    const threadOpts = {
      model: input.modelId || undefined,
      sandboxMode: "workspace-write" as const,
      workingDirectory: input.cwd,
      // "never" = auto-approve: built-in tools are disabled by SDK config above,
      // so this only affects MCP tools whose permissions our bridge already gates.
      approvalPolicy: "never" as const,
      webSearchMode: "disabled" as const,
      webSearchEnabled: false,
      networkAccessEnabled: false,
    }

    const thread = input.threadId ? codex.resumeThread(input.threadId, threadOpts) : codex.startThread(threadOpts)

    const turnInput = composeCodexTurnInput(input.prompt, input.systemPrompt)
    const { events } = await thread.runStreamed(turnInput, { signal: abortController.signal })
    let resolvedThreadId = input.threadId ?? ""

    for await (const rawEvent of events) {
      const event = rawEvent as StreamEvent
      const eventType = asString(event.type)

      if (eventType === "thread.started") {
        resolvedThreadId = asString(event.thread_id) || resolvedThreadId
        continue
      }

      if (eventType === "turn.started") {
        yield { type: "step-start" }
        continue
      }

      if (eventType === "turn.completed") {
        yield { type: "step-end" }
        const threadId = thread.id ?? resolvedThreadId
        if (threadId) yield { type: "done", threadId }
        continue
      }

      if (eventType === "turn.failed") {
        yield { type: "error", message: asString(event.error?.message) || "Codex turn failed" }
        continue
      }

      if (eventType === "error") {
        yield { type: "error", message: asString(event.message) || "Codex error" }
        continue
      }

      if (eventType !== "item.started" && eventType !== "item.updated" && eventType !== "item.completed") {
        continue
      }

      const item = event.item
      if (!item) continue
      const itemType = asString(item.type)
      const itemId = asString(item.id)

      if (isPolicyRestrictedItem(itemType)) {
        const msg = `Codex policy violation: built-in tool "${itemType}" is disabled; only MCP tools are allowed.`
        log.warn("policy violation", {
          itemType,
          itemId,
          threadId: thread.id ?? resolvedThreadId,
        })
        yield { type: "error", message: msg }
        abortController.abort()
        return
      }

      if (itemType === "agent_message") {
        const nextText = asString(item.text)
        const prev = textByItem.get(itemId) ?? ""
        if (nextText.length >= prev.length) {
          const delta = nextText.slice(prev.length)
          if (delta) yield { type: "text-delta", text: delta }
        } else if (nextText) {
          yield { type: "text-delta", text: nextText }
        }
        textByItem.set(itemId, nextText)
        continue
      }

      if (itemType === "reasoning") {
        const nextText = asString(item.text)
        const prev = textByItem.get(itemId) ?? ""
        if (nextText.length >= prev.length) {
          const delta = nextText.slice(prev.length)
          if (delta) yield { type: "reasoning-delta", id: itemId || "reasoning", text: delta }
        } else if (nextText) {
          yield { type: "reasoning-delta", id: itemId || "reasoning", text: nextText }
        }
        textByItem.set(itemId, nextText)
        continue
      }

      if (itemType !== "mcp_tool_call") continue

      const status = asString(item.status)
      const toolName = [asString(item.server), asString(item.tool)].filter(Boolean).join("/")
      const argsText = stringifyUnknown(item.arguments)

      if (eventType === "item.started") {
        mcpArgsSeen.add(itemId)
        yield { type: "tool-start", id: itemId, tool: toolName || "mcp_tool_call" }
        if (argsText) yield { type: "tool-output", id: itemId, output: argsText }
        continue
      }

      if (eventType === "item.updated" && !mcpArgsSeen.has(itemId)) {
        mcpArgsSeen.add(itemId)
        yield { type: "tool-start", id: itemId, tool: toolName || "mcp_tool_call" }
        if (argsText) yield { type: "tool-output", id: itemId, output: argsText }
      }

      if (eventType === "item.completed" || status === "completed" || status === "failed") {
        const output = item.error ? asString(item.error.message) : formatMcpResult(item.result)
        const prevOutput = outputByItem.get(itemId) ?? ""
        if (output && output !== prevOutput) {
          yield { type: "tool-output", id: itemId, output }
          outputByItem.set(itemId, output)
        }
        yield { type: "tool-end", id: itemId, output: output || "" }
      }
    }
  } catch (err: unknown) {
    if (abortController.signal.aborted) return
    yield { type: "error", message: normalizeCodexErrorMessage(err) }
  } finally {
    input.abort.removeEventListener("abort", onAbort)
    unregisterBridge(bridgeId)
  }
}
