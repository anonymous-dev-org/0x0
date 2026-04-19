#!/usr/bin/env bun
/**
 * MCP server exposing a snapshot of the current Neovim editor state.
 * The Neovim plugin writes a JSON state file before each Claude request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const STATE_PATH = process.env.ZEROXZERO_NVIM_STATE

async function readState(): Promise<Record<string, unknown>> {
  if (!STATE_PATH) {
    return {}
  }

  try {
    const text = await Bun.file(STATE_PATH).text()
    if (!text.trim()) {
      return {}
    }
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Ignore transient state-read issues; tools return an empty snapshot.
  }

  return {}
}

const server = new McpServer({
  name: "0x0-nvim",
  version: "1.0.0",
})

server.tool(
  "nvim_context",
  "Read the current Neovim context snapshot, including the active buffer, any explicit selection, and queued context items.",
  {},
  async () => {
    const state = await readState()
    return {
      content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
    }
  },
)

server.tool(
  "nvim_diagnostics",
  "Read diagnostics captured from Neovim. Optionally filter by relative or absolute file path.",
  {
    filepath: z.string().optional().describe("Optional file path to filter diagnostics."),
  },
  async ({ filepath }) => {
    const state = await readState()
    const diagnostics = Array.isArray(state.diagnostics) ? state.diagnostics : []
    const filtered = filepath
      ? diagnostics.filter((item) => {
          if (!item || typeof item !== "object") return false
          const record = item as Record<string, unknown>
          return record.filepath === filepath || record.relative_path === filepath
        })
      : diagnostics

    return {
      content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
