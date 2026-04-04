#!/usr/bin/env bun
/**
 * MCP server (stdio transport) exposing workgroup tools.
 * Launched by the Claude CLI via --mcp-config.
 * Calls back to the 0x0 server's /workgroup HTTP endpoint.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const BASE_URL = process.env.ZEROXZERO_URL ?? "http://localhost:4096"

// ── Helper: call the 0x0 server workgroup API ──────────────────────

async function callWorkgroupApi(body: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${BASE_URL}/workgroup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Workgroup API error ${resp.status}: ${text}`)
  }

  const contentType = resp.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const text = await resp.text()
    let result = ""
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      try {
        const event = JSON.parse(line.slice(5).trim())
        if (event.type === "text_delta") result += event.text
        if (event.type === "result" && event.result) result = event.result
      } catch {
        // skip
      }
    }
    return result || "[no response]"
  }

  return await resp.text()
}

/**
 * Streaming variant: call the workgroup API and emit MCP progress notifications
 * as the sub-agent works, so the orchestrator can relay activity to the TUI.
 */
async function callWorkgroupApiWithProgress(
  body: Record<string, unknown>,
  progressToken: string | number | undefined,
  sendNotification: ((notification: {
    method: "notifications/progress"
    params: {
      progressToken: string | number
      progress: number
      message: string
    }
  }) => Promise<void>) | undefined,
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/workgroup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Workgroup API error ${resp.status}: ${text}`)
  }

  const contentType = resp.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    return await resp.text()
  }

  const text = await resp.text()
  let result = ""
  let toolCount = 0

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      const event = JSON.parse(line.slice(5).trim())

      if (event.type === "text_delta") {
        result += event.text
      }
      if (event.type === "result" && event.result) {
        result = event.result
      }
      // Emit progress for tool_use events so the TUI sees sub-agent activity
      if (
        event.type === "tool_use" &&
        progressToken !== undefined &&
        sendNotification !== undefined
      ) {
        toolCount++
        try {
          await sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: toolCount,
              message: `Tool: ${event.name}`,
            },
          })
        } catch {
          // progress notifications are best-effort
        }
      }
    } catch {
      // skip
    }
  }

  return result || "[no response]"
}

// ── MCP server setup ────────────────────────────────────────────────

const server = new McpServer({
  name: "0x0-workgroup",
  version: "1.0.0",
})

// Tool: workgroup_open
server.tool(
  "workgroup_open",
  "Spawn 1-6 parallel AI agents, each with its own conversation session. " +
    "Returns a workgroup_id and session IDs for each agent. " +
    "Give each agent a specific system_prompt that defines its expertise — agents cannot see each other's work unless you relay it via workgroup_message.",
  {
    agents: z.array(z.object({
      name: z.string().describe("Short descriptive name (e.g. 'arch-reviewer', 'security-auditor')"),
      provider: z.string().describe("'claude' or 'codex'"),
      model: z.string().optional().describe("Model override (e.g. 'sonnet', 'opus', 'codex-mini-latest')"),
      system_prompt: z.string().optional().describe("Define the agent's expertise and role. Be specific (e.g. 'You are an expert in async Rust networking and error handling. Review code for race conditions, error propagation, and resource leaks.')"),
    })).min(1).max(6).describe("Agents to spawn"),
  },
  async ({ agents }) => {
    const result = await callWorkgroupApi({ action: "open", agents })
    return { content: [{ type: "text" as const, text: result }] }
  },
)

// Tool: workgroup_message
server.tool(
  "workgroup_message",
  "Send a task or message to a specific agent. The prompt must be self-contained — " +
    "include all code, context, and instructions the agent needs since it cannot access your tools or other agents' responses. " +
    "Returns the agent's full response. Use this for initial tasks, follow-up questions, or relaying another agent's findings for cross-review.",
  {
    workgroup_id: z.string().describe("Workgroup ID from workgroup_open"),
    agent_name: z.string().describe("Name of the agent to message"),
    prompt: z.string().describe("Self-contained message with all context the agent needs"),
  },
  async ({ workgroup_id, agent_name, prompt }, extra) => {
    const result = await callWorkgroupApiWithProgress(
      { action: "message", workgroup_id, agent_name, prompt },
      extra._meta?.progressToken,
      extra.sendNotification,
    )
    return { content: [{ type: "text" as const, text: result }] }
  },
)

// Tool: workgroup_broadcast
server.tool(
  "workgroup_broadcast",
  "Send the same message to ALL agents simultaneously and wait for all responses. " +
    "Returns a map of agent_name -> response. Best for initial task distribution (same code to review) " +
    "or final collection ('summarize your top 3 findings'). For agent-specific follow-ups, use workgroup_message instead.",
  {
    workgroup_id: z.string().describe("Workgroup ID from workgroup_open"),
    prompt: z.string().describe("Message sent to every agent — include all shared context"),
  },
  async ({ workgroup_id, prompt }) => {
    const result = await callWorkgroupApi({
      action: "broadcast",
      workgroup_id,
      prompt,
    })
    return { content: [{ type: "text" as const, text: result }] }
  },
)

// Tool: workgroup_status
server.tool(
  "workgroup_status",
  "Check which agents are idle or busy and see their last response. " +
    "Use to poll progress when agents are working on long tasks.",
  {
    workgroup_id: z.string().describe("Workgroup ID"),
  },
  async ({ workgroup_id }) => {
    const result = await callWorkgroupApi({
      action: "status",
      workgroup_id,
    })
    return { content: [{ type: "text" as const, text: result }] }
  },
)

// Tool: workgroup_close
server.tool(
  "workgroup_close",
  "Tear down the workgroup and all agent sessions. Always call this when done.",
  {
    workgroup_id: z.string().describe("Workgroup ID to close"),
  },
  async ({ workgroup_id }) => {
    const result = await callWorkgroupApi({
      action: "close",
      workgroup_id,
    })
    return { content: [{ type: "text" as const, text: result }] }
  },
)

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
