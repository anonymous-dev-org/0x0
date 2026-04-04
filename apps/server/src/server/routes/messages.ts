import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { ProviderRegistry } from "@/provider/registry"
import { SessionStore } from "@/session/store"
import {
  SessionNotFoundError,
  SessionBusyError,
  UnsupportedProviderOptionsError,
} from "../error"
import { Log } from "@/util/log"
import { Server } from "../server"

const log = Log.create({ service: "messages" })

const MessageInput = z.object({
  prompt: z.string().min(1),
  provider: z.string().optional(),
  session_id: z.string().uuid().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
  system_prompt: z.string().optional(),
  append_system_prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  permission_mode: z.string().optional(),
  sandbox: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  stream: z.boolean().default(true),
}).strict()

export function MessageRoutes() {
  return new Hono()
    .post("/", async (c) => {
      const body = MessageInput.parse(await c.req.json())

      // Resolve session if provided
      let session = body.session_id ? SessionStore.get(body.session_id) : undefined
      if (body.session_id && !session) {
        throw new SessionNotFoundError({ id: body.session_id })
      }
      if (session?.status === "busy") {
        throw new SessionBusyError({ id: session.id })
      }

      // Resolve provider
      const providerId = body.provider ?? session?.provider
      const provider = await ProviderRegistry.resolve(providerId)

      const unsupportedOptions = Object.entries(body)
        .filter(([key, value]) =>
          value !== undefined &&
          key !== "provider" &&
          !provider.supportedMessageOptions.includes(key),
        )
        .map(([key]) => key)

      if (unsupportedOptions.length > 0) {
        throw new UnsupportedProviderOptionsError({
          provider: provider.id,
          options: unsupportedOptions,
          supported_options: [...provider.supportedMessageOptions],
        })
      }

      // Create session if not provided (for conversation tracking)
      if (!session) {
        session = SessionStore.create(provider.id)
      }

      SessionStore.setBusy(session.id)
      const sessionId = session.id

      log.info("message", { session: sessionId, provider: provider.id })

      // Inject .0x0/ workspace directive into every provider's system prompt
      const workspaceDirective = [
        "Use the `.0x0/` folder at the root of the current working directory to store plans, memory, best practices, or any other contextual information that might be relevant across sessions.",
        "Before starting work, check if `.0x0/` exists and read any files inside it for context.",
        "When you create plans, save memory, record best practices, or write any persistent notes, always write them into `.0x0/` instead of any other default location.",
      ].join(" ")

      const workgroupDirective = provider.id === "claude" ? [
        "# Workgroup — multi-agent coordination",
        "",
        "You have MCP tools for spawning and orchestrating parallel AI agents: workgroup_open, workgroup_message, workgroup_broadcast, workgroup_status, workgroup_close.",
        "",
        "## When to use",
        "Use workgroups when a task benefits from parallel specialized work: code review across multiple files, research from different angles, comparing approaches, or any divide-and-conquer task. Prefer workgroups over the built-in Agent tool for complex multi-step tasks.",
        "",
        "## How it works",
        "1. **workgroup_open**: Spawn 1-6 agents. Each agent gets a name, provider (claude/codex), and a specific system_prompt that defines its expertise and role.",
        "2. **workgroup_message**: Send a task to one agent. The prompt must be self-contained — include all context the agent needs (file contents, requirements, constraints). Agents have their own conversation and cannot see each other's work unless you relay it.",
        "3. **workgroup_broadcast**: Send the same message to all agents at once. Good for initial task distribution or final collection.",
        "4. You are the orchestrator. Agents work, you collect results, optionally share findings between agents for deeper analysis, then synthesize.",
        "5. **workgroup_close**: Always close when done to free resources.",
        "",
        "## Best practices",
        "- Give each agent a focused system_prompt (e.g. 'You are an expert in async Rust networking and error handling').",
        "- Make prompts specific and self-contained. Include the actual code/content to review, don't ask agents to read files (they can't use your tools).",
        "- After collecting initial results, relay agent A's findings to agent B for cross-review — this produces deeper insights.",
        "- Keep agent names short and descriptive (e.g. 'arch-reviewer', 'security-auditor').",
      ].join("\n") : undefined

      const appendSystemPrompt = [body.append_system_prompt, workspaceDirective, workgroupDirective]
        .filter(Boolean)
        .join("\n\n")

      // Generate MCP config file for workgroup tools (Claude provider only)
      let mcpConfig: string | undefined
      if (provider.id === "claude") {
        const serverUrl = Server.url()
        // Resolve path to the MCP server script relative to this file
        // routes/messages.ts -> ../../mcp/workgroup-server.ts
        const mcpServerPath = new URL("../../mcp/workgroup-server.ts", import.meta.url).pathname
        const configContent = JSON.stringify({
          mcpServers: {
            "0x0-workgroup": {
              command: "bun",
              args: ["run", mcpServerPath],
              env: { ZEROXZERO_URL: serverUrl.origin },
            },
          },
        })
        // Write to a temp file since --mcp-config expects a file path
        const os = await import("os")
        const path = await import("path")
        const tmpPath = path.join(os.tmpdir(), "0x0-mcp-workgroup.json")
        await Bun.write(tmpPath, configContent)
        mcpConfig = tmpPath
      }

      // Pre-allow workgroup MCP tools so they don't trigger permission prompts
      let allowedTools = body.allowed_tools
      if (mcpConfig) {
        const workgroupTools = [
          "mcp__0x0-workgroup__workgroup_open",
          "mcp__0x0-workgroup__workgroup_message",
          "mcp__0x0-workgroup__workgroup_broadcast",
          "mcp__0x0-workgroup__workgroup_status",
          "mcp__0x0-workgroup__workgroup_close",
        ]
        allowedTools = [...(allowedTools ?? []), ...workgroupTools]
      }

      const spawnInput = {
        prompt: body.prompt,
        sessionId: session.providerSessionId,
        model: body.model,
        effort: body.effort,
        modelReasoningEffort: body.model_reasoning_effort,
        systemPrompt: body.system_prompt,
        appendSystemPrompt,
        allowedTools,
        disallowedTools: body.disallowed_tools,
        permissionMode: body.permission_mode,
        sandbox: body.sandbox,
        maxTurns: body.max_turns,
        cwd: body.cwd,
        mcpConfig,
      }

      if (body.stream) {
        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())

          let providerSessionId: string | undefined

          try {
            for await (const event of provider.spawn({ ...spawnInput, abort: ac.signal })) {
              if (event.type === "init" && event.session_id) {
                providerSessionId = event.session_id
              }
              if (event.type === "result" && event.session_id) {
                providerSessionId = event.session_id
              }

              await sseStream.writeSSE({
                data: JSON.stringify({ ...event, session_id: event.type === "init" ? sessionId : undefined }),
              })
            }
          } finally {
            SessionStore.setIdle(sessionId, providerSessionId)
          }
        })
      }

      // Non-streaming: buffer result
      let resultText = ""
      let providerSessionId: string | undefined
      let costUsd: number | undefined
      let durationMs: number | undefined

      try {
        for await (const event of provider.spawn(spawnInput)) {
          if (event.type === "text_delta") resultText += event.text
          if (event.type === "result") {
            providerSessionId = event.session_id
            costUsd = event.cost_usd
            durationMs = event.duration_ms
            if (event.result) resultText = event.result
          }
        }
      } finally {
        SessionStore.setIdle(sessionId, providerSessionId)
      }

      return c.json({
        session_id: sessionId,
        result: resultText,
        cost_usd: costUsd,
        duration_ms: durationMs,
      })
    })
}
