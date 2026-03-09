import { Hono } from "hono"
import z from "zod"
import { PermissionNext } from "@/permission/next"
import type { Agent } from "@/runtime/agent/agent"
import { Question } from "@/runtime/question"
import { Session } from "@/session"
import type { Tool } from "@/tool/tool"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "tool-bridge" })

// ─── Supported MCP protocol versions (newest first) ──────────────────────────

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

// ─── SDK-style name ↔ registry ID mapping ────────────────────────────────────

const REGISTRY_ID_TO_SDK_NAME: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  search: "Grep",
  task: "Task",
  search_remote: "WebSearch",
  todo_write: "TodoWrite",
  question: "AskUserQuestion",
  apply_patch: "ApplyPatch",
  lsp: "Lsp",
  docs: "Docs",
  plan: "Plan",
}

const SDK_NAME_TO_REGISTRY_ID: Record<string, string> = {}
for (const [registryId, sdkName] of Object.entries(REGISTRY_ID_TO_SDK_NAME)) {
  SDK_NAME_TO_REGISTRY_ID[sdkName] = registryId
}

function toolPermission(sdkName: string): string {
  switch (sdkName) {
    case "Bash":
      return "bash"
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit"
    case "Read":
      return "read"
    case "Glob":
    case "Grep":
      return "search"
    case "Task":
      return "task"
    case "WebFetch":
    case "WebSearch":
      return "web"
    default:
      return sdkName.toLowerCase()
  }
}

function toolPattern(sdkName: string, input: Record<string, unknown>): string {
  function field(...keys: string[]): string {
    for (const key of keys) {
      const val = input[key]
      if (typeof val === "string" && val) return val
    }
    return "*"
  }
  switch (sdkName) {
    case "Bash":
      return field("command")
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return field("file_path", "path")
    case "Read":
      return field("file_path")
    case "Glob":
      return field("pattern")
    case "Grep":
      return field("path", "pattern")
    case "Task":
      return field("prompt", "description")
    case "WebFetch":
      return field("url")
    case "WebSearch":
      return field("query")
    default:
      return "*"
  }
}

// ─── Bridge context ──────────────────────────────────────────────────────────

export interface BridgeContext {
  sessionID: string
  agentName: string
  agent: Agent.Info
  abort: AbortSignal
  tools: Array<{
    id: string
    description: string
    parameters: z.ZodType
    execute: (args: any, ctx: Tool.Context) => Promise<{ title: string; metadata: any; output: string }>
  }>
}

const bridges = new Map<string, BridgeContext>()

// Track MCP session IDs per bridge (Streamable HTTP requirement)
const bridgeSessions = new Map<string, string>()

function getOrCreateSessionId(bridgeId: string): string {
  let sessionId = bridgeSessions.get(bridgeId)
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    bridgeSessions.set(bridgeId, sessionId)
  }
  return sessionId
}

export function registerBridge(id: string, ctx: BridgeContext) {
  bridges.set(id, ctx)
  log.info("bridge registered", { id, sessionID: ctx.sessionID, agent: ctx.agentName, tools: ctx.tools.map(t => t.id) })
}

export function unregisterBridge(id: string) {
  bridges.delete(id)
  bridgeSessions.delete(id)
  log.info("bridge unregistered", { id })
}

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

function jsonRpcOk(id: string | number | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result }
}

function jsonRpcError(id: string | number | undefined, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } }
}

// ─── Tool schema conversion with error isolation ─────────────────────────────

interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function convertToolSchemas(bridgeTools: BridgeContext["tools"]): McpToolDefinition[] {
  const tools: McpToolDefinition[] = []
  const failures: string[] = []

  for (const t of bridgeTools) {
    const sdkName = REGISTRY_ID_TO_SDK_NAME[t.id] ?? t.id
    try {
      const inputSchema = z.toJSONSchema(t.parameters)
      tools.push({ name: sdkName, description: t.description, inputSchema })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${sdkName} (${t.id}): ${message}`)
    }
  }

  if (failures.length > 0) {
    log.warn("schema conversion failures", { count: failures.length, failures })
  }

  log.info("tools/list", { total: bridgeTools.length, served: tools.length, failed: failures.length })
  return tools
}

// ─── Negotiate protocol version ──────────────────────────────────────────────

function negotiateProtocolVersion(clientVersion: string | undefined): string {
  if (!clientVersion) return LATEST_PROTOCOL_VERSION
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)) return clientVersion
  // Client requested an unsupported version — respond with our latest
  return LATEST_PROTOCOL_VERSION
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const ToolBridgeRoutes = lazy(() =>
  new Hono()
    .get("/:bridgeId", c => {
      const bridgeId = c.req.param("bridgeId")
      const bridge = bridges.get(bridgeId)
      if (!bridge) {
        return c.json({ error: `Bridge ${bridgeId} not found` }, 404)
      }

      // Streamable HTTP 2025-03-26: GET opens an SSE stream for server-initiated messages.
      // We don't push server-initiated messages, so return an empty SSE stream that stays open
      // until the bridge is unregistered (signals the client we're alive and MCP-compliant).
      const accept = c.req.header("accept") ?? ""
      if (!accept.includes("text/event-stream")) {
        return c.json({ error: "Accept header must include text/event-stream for GET requests" }, 406)
      }

      const mcpSessionId = getOrCreateSessionId(bridgeId)

      return new Response(
        new ReadableStream({
          start(controller) {
            // Send a keep-alive comment immediately so the client knows we're connected
            controller.enqueue(new TextEncoder().encode(": mcp session open\n\n"))

            // Close when the bridge is unregistered or the client disconnects
            const checkInterval = setInterval(() => {
              if (!bridges.has(bridgeId)) {
                clearInterval(checkInterval)
                controller.close()
              }
            }, 5000)

            // Also close on abort
            bridge.abort.addEventListener(
              "abort",
              () => {
                clearInterval(checkInterval)
                try {
                  controller.close()
                } catch {}
              },
              { once: true }
            )
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Mcp-Session-Id": mcpSessionId,
          },
        }
      )
    })
    .delete("/:bridgeId", c => {
      // Streamable HTTP 2025-03-26: DELETE terminates the MCP session
      const bridgeId = c.req.param("bridgeId")
      const mcpSessionId = bridgeSessions.get(bridgeId)
      if (!mcpSessionId) {
        return c.json({ error: "Session not found" }, 404)
      }
      bridgeSessions.delete(bridgeId)
      return c.body(null, 204)
    })
    .post("/:bridgeId", async c => {
      const bridgeId = c.req.param("bridgeId")
      const bridge = bridges.get(bridgeId)
      if (!bridge) {
        return c.json(jsonRpcError(undefined, -32000, `Bridge ${bridgeId} not found`), 404)
      }

      const mcpSessionId = getOrCreateSessionId(bridgeId)

      let body: JsonRpcRequest
      try {
        body = await c.req.json<JsonRpcRequest>()
      } catch {
        return c.json(jsonRpcError(undefined, -32700, "Parse error"), 400)
      }

      const { method, id, params } = body
      log.debug("MCP request", { bridgeId, method })

      const result = await handleMethod(method, id, params, bridgeId, bridge, c)

      // Attach Mcp-Session-Id header to all POST responses
      if (result instanceof Response) {
        result.headers.set("Mcp-Session-Id", mcpSessionId)
        return result
      }

      c.header("Mcp-Session-Id", mcpSessionId)
      return result
    })
)

async function handleMethod(
  method: string,
  id: string | number | undefined,
  params: Record<string, unknown> | undefined,
  bridgeId: string,
  bridge: BridgeContext,
  c: import("hono").Context
) {
  switch (method) {
    case "initialize": {
      const clientVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined
      const negotiatedVersion = negotiateProtocolVersion(clientVersion)
      log.info("initialize", { bridgeId, clientVersion, negotiatedVersion })
      return c.json(
        jsonRpcOk(id, {
          protocolVersion: negotiatedVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "tools", version: "1.0.0" },
        })
      )
    }

    case "notifications/initialized": {
      // Client acknowledging initialization — no response needed for JSON-RPC notifications
      // Per spec, notifications (no id) should return 204. If id is present, respond normally.
      if (id === undefined) return c.body(null, 204)
      return c.json(jsonRpcOk(id, {}))
    }

    case "tools/list": {
      const tools = convertToolSchemas(bridge.tools)
      return c.json(jsonRpcOk(id, { tools }))
    }

    case "tools/call": {
      return handleToolCall(c, id, bridgeId, bridge, params)
    }

    case "resources/list": {
      return c.json(jsonRpcOk(id, { resources: [] }))
    }

    case "resources/templates/list": {
      return c.json(jsonRpcOk(id, { resourceTemplates: [] }))
    }

    case "prompts/list": {
      return c.json(jsonRpcOk(id, { prompts: [] }))
    }

    default: {
      log.debug("unhandled MCP method", { bridgeId, method })
      return c.json(jsonRpcError(id, -32601, `Method not found: ${method}`))
    }
  }
}

async function handleToolCall(
  c: import("hono").Context,
  id: string | number | undefined,
  bridgeId: string,
  bridge: BridgeContext,
  params: Record<string, unknown> | undefined
) {
  const toolName = (params as any)?.name as string
  const toolArgs = ((params as any)?.arguments ?? {}) as Record<string, unknown>

  if (!toolName) {
    return c.json(jsonRpcError(id, -32602, "Missing tool name"))
  }

  // Map SDK name → registry ID
  const registryId = SDK_NAME_TO_REGISTRY_ID[toolName] ?? toolName.toLowerCase()
  const toolInfo = bridge.tools.find(t => t.id === registryId)
  if (!toolInfo) {
    return c.json(jsonRpcError(id, -32602, `Tool "${toolName}" not found`))
  }

  // Check if this is the question tool — route through Question.ask
  if (registryId === "question") {
    return await handleQuestionTool(c, id, bridge, toolArgs)
  }

  // Permission gate
  const agentActions = bridge.agent.actions ?? {}
  const sdkName = REGISTRY_ID_TO_SDK_NAME[registryId] ?? toolName
  const policy = agentActions[sdkName]

  if (policy !== "allow") {
    // Need to check permission rules
    const session = await Session.get(bridge.sessionID).catch(() => null)
    const ruleset = PermissionNext.merge(bridge.agent.permission, session?.permission ?? [])
    const rule = PermissionNext.evaluate(toolPermission(sdkName), toolPattern(sdkName, toolArgs), ruleset)

    if (rule.action === "deny") {
      return c.json(
        jsonRpcOk(id, {
          content: [{ type: "text", text: `Tool "${toolName}" denied by permission policy.` }],
          isError: true,
        })
      )
    }

    if (rule.action === "ask") {
      try {
        await PermissionNext.ask({
          sessionID: bridge.sessionID,
          permission: toolPermission(sdkName),
          patterns: [toolPattern(sdkName, toolArgs)],
          metadata: { tool: sdkName, provider: "claude-code", agent: bridge.agentName },
          always: ["*"],
          ruleset,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Permission denied."
        return c.json(
          jsonRpcOk(id, {
            content: [{ type: "text", text: msg }],
            isError: true,
          })
        )
      }
    }
  }

  // Build Tool.Context
  const messageID = `bridge-${bridgeId}`
  const callID = crypto.randomUUID()
  const ctx: Tool.Context = {
    sessionID: bridge.sessionID,
    messageID,
    agent: bridge.agentName,
    abort: bridge.abort,
    callID,
    messages: [],
    metadata: () => {},
    ask: async req => {
      const session = await Session.get(bridge.sessionID).catch(() => null)
      await PermissionNext.ask({
        ...req,
        sessionID: bridge.sessionID,
        tool: { messageID, callID },
        ruleset: PermissionNext.merge(bridge.agent.permission, session?.permission ?? []),
      })
    },
  }

  // Execute
  try {
    const result = await toolInfo.execute(toolArgs, ctx)
    return c.json(
      jsonRpcOk(id, {
        content: [{ type: "text", text: result.output }],
      })
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json(
      jsonRpcOk(id, {
        content: [{ type: "text", text: msg }],
        isError: true,
      })
    )
  }
}

async function handleQuestionTool(
  c: import("hono").Context,
  rpcId: string | number | undefined,
  bridge: BridgeContext,
  toolArgs: Record<string, unknown>
) {
  const rawQuestions = toolArgs.questions as
    | Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect?: boolean
        multiple?: boolean
      }>
    | undefined

  if (!rawQuestions?.length) {
    return c.json(
      jsonRpcOk(rpcId, {
        content: [{ type: "text", text: "No questions provided." }],
        isError: true,
      })
    )
  }

  const questions = rawQuestions.map(q => ({
    question: q.question,
    header: q.header,
    options: q.options,
    multiple: q.multiSelect ?? q.multiple,
  }))

  // Blocking: register the question and wait for the user's answer.
  // The promise resolves when the user replies via the question route,
  // or rejects if the user dismisses / session aborts.
  try {
    const answers = await Question.ask({
      sessionID: bridge.sessionID,
      questions,
    })

    const summary = questions.map((q, i) => `Q: ${q.question}\nA: ${(answers[i] ?? []).join(", ")}`).join("\n\n")

    return c.json(
      jsonRpcOk(rpcId, {
        content: [{ type: "text", text: `The user answered your questions:\n\n${summary}` }],
      })
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The user dismissed this question"
    return c.json(
      jsonRpcOk(rpcId, {
        content: [{ type: "text", text: msg }],
        isError: true,
      })
    )
  }
}
