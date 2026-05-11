// Tool definitions exposed to Claude. The MVP set forwards filesystem
// operations to the client (0x0.nvim) via ACP server→client requests,
// so reconcile.lua keeps governing host disk access.

import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  FsWriteTextFileResult,
  ToolContext,
  ToolDefinition,
} from "./types"

interface ReadFileInput {
  path: string
  line?: number
  limit?: number
}
interface ReadFileOutput {
  content: string
}

interface WriteFileInput {
  path: string
  content: string
}
interface WriteFileOutput {
  ok: true
}

export const readFile: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the project. Always prefer this over fetch/web tools. " +
    "Use `line` and `limit` for large files.",
  kind: "read",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or repo-relative path." },
      line: { type: "integer", description: "1-based start line." },
      limit: { type: "integer", description: "Maximum number of lines to return." },
    },
    required: ["path"],
  },
  dispatch: async (input, ctx: ToolContext): Promise<ReadFileOutput> => {
    const params: FsReadTextFileParams = {
      sessionId: ctx.sessionId,
      path: input.path,
    }
    if (typeof input.line === "number") params.line = input.line
    if (typeof input.limit === "number") params.limit = input.limit
    const result = await ctx.request<FsReadTextFileResult>("fs/read_text_file", params)
    return { content: result.content }
  },
}

export const writeFile: ToolDefinition<WriteFileInput, WriteFileOutput> = {
  name: "write_file",
  description:
    "Write a file in the project. The host runs a reconciliation check; " +
    "if the user has edited the file since you last read it, the write is rejected.",
  kind: "edit",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or repo-relative path." },
      content: { type: "string", description: "Full new file contents (no diff format)." },
    },
    required: ["path", "content"],
  },
  dispatch: async (input, ctx: ToolContext): Promise<WriteFileOutput> => {
    const params: FsWriteTextFileParams = {
      sessionId: ctx.sessionId,
      path: input.path,
      content: input.content,
    }
    await ctx.request<FsWriteTextFileResult>("fs/write_text_file", params)
    return { ok: true }
  },
}

export const ALL_TOOLS: ToolDefinition[] = [
  readFile as ToolDefinition,
  writeFile as ToolDefinition,
]

export function toolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find(t => t.name === name)
}

/** Anthropic SDK Tool shape. Cast keeps the schema flexible while
 * satisfying the InputSchema constraint (root type must be "object"). */
export function toAnthropicTools(): {
  name: string
  description: string
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[] }
}[] {
  return ALL_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as {
      type: "object"
      properties?: Record<string, unknown>
      required?: string[]
    },
  }))
}
