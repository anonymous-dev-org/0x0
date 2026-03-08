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

export function registerBridge(id: string, ctx: BridgeContext) {
  bridges.set(id, ctx)
  log.info("bridge registered", { id, sessionID: ctx.sessionID, agent: ctx.agentName, tools: ctx.tools.map(t => t.id) })
}

export function unregisterBridge(id: string) {
  bridges.delete(id)
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

// ─── Route ───────────────────────────────────────────────────────────────────

export const ToolBridgeRoutes = lazy(() =>
  new Hono()
    .get("/:bridgeId", c => {
      return c.json({ error: "Method Not Allowed. Use POST for MCP JSON-RPC." }, 405)
    })
    .post("/:bridgeId", async c => {
      const bridgeId = c.req.param("bridgeId")
      const bridge = bridges.get(bridgeId)
      if (!bridge) {
        return c.json(jsonRpcError(undefined, -32000, `Bridge ${bridgeId} not found`), 404)
      }

      let body: JsonRpcRequest
      try {
        body = await c.req.json<JsonRpcRequest>()
      } catch {
        return c.json(jsonRpcError(undefined, -32700, "Parse error"), 400)
      }

      const { method, id, params } = body
      log.debug("MCP request", { bridgeId, method })

      switch (method) {
        case "initialize": {
          return c.json(
            jsonRpcOk(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: "tools", version: "1.0.0" },
            })
          )
        }

        case "notifications/initialized": {
          // Client acknowledging initialization — no response needed
          return c.json(jsonRpcOk(id, {}))
        }

        case "tools/list": {
          const tools = bridge.tools.map(t => {
            const sdkName = REGISTRY_ID_TO_SDK_NAME[t.id] ?? t.id
            return {
              name: sdkName,
              description: t.description,
              inputSchema: z.toJSONSchema(t.parameters),
            }
          })
          return c.json(jsonRpcOk(id, { tools }))
        }

        case "tools/call": {
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
    })
)

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

  // Non-blocking: register the question and return immediately.
  // The session prompt loop will detect pending questions after the model turn
  // ends, wait for the user's answer, and inject it as a synthetic user message.
  await Question.register({
    sessionID: bridge.sessionID,
    questions: rawQuestions.map(q => ({
      question: q.question,
      header: q.header,
      options: q.options,
      multiple: q.multiSelect ?? q.multiple,
    })),
  })

  return c.json(
    jsonRpcOk(rpcId, {
      content: [
        {
          type: "text",
          text: "Question has been registered and will be shown to the user. Your turn is now ending — the user's answer will be provided in the next message.",
        },
      ],
    })
  )
}
