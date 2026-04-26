import { stepCountIs, streamText, tool, type LanguageModel } from "ai"
import { z } from "zod"
import { runCodeTool } from "./tools"

type ToolContext = {
  repoRoot: string
  worktreePath: string
}

type RunAiAgentInput = ToolContext & {
  model: LanguageModel
  prompt: string
  systemPrompt: string
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

const MAX_AGENT_STEPS = 10

function formatToolResult(result: { ok: boolean; output: string }) {
  return JSON.stringify(result)
}

function createCodeTools(context: ToolContext) {
  return {
    list_files: tool({
      description:
        "List files in the agent worktree. Prefer this or search before reading unknown paths.",
      inputSchema: z.object({
        path: z.string().optional().describe("Optional directory relative to the worktree."),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "list_files", input, options.abortSignal)),
    }),
    read_file: tool({
      description: "Read a UTF-8 text file from the agent worktree, optionally by 1-based line range.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "read_file", input, options.abortSignal)),
    }),
    search: tool({
      description: "Search the worktree with ripgrep and return path:line matches.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().describe("Optional file or directory relative to the worktree."),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "search", input, options.abortSignal)),
    }),
    apply_patch: tool({
      description: "Apply an apply_patch-style patch to files in the agent worktree.",
      inputSchema: z.object({
        patch: z.string(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "apply_patch", input, options.abortSignal)),
    }),
    write_file: tool({
      description: "Create a new small file or explicitly overwrite a small file in the agent worktree.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "write_file", input, options.abortSignal)),
    }),
    bash: tool({
      description:
        "Run an allowlisted shell command in the agent worktree for inspection, tests, formatters, or codegen.",
      inputSchema: z.object({
        command: z.string(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "bash", input, options.abortSignal)),
    }),
    git_status: tool({
      description: "Return git status for the agent worktree.",
      inputSchema: z.object({}),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "git_status", input, options.abortSignal)),
    }),
    git_diff: tool({
      description: "Return the unstaged Git diff for the agent worktree.",
      inputSchema: z.object({}),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "git_diff", input, options.abortSignal)),
    }),
    context7_resolve_library: tool({
      description: "Resolve a library name with Context7 MCP when the server has Context7 configured.",
      inputSchema: z.object({
        libraryName: z.string(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "context7_resolve_library", input, options.abortSignal)),
    }),
    context7_get_docs: tool({
      description: "Fetch library documentation with Context7 MCP when the server has Context7 configured.",
      inputSchema: z.object({
        context7CompatibleLibraryID: z.string(),
        topic: z.string().optional(),
        tokens: z.number().int().positive().optional(),
      }),
      execute: async (input, options) =>
        formatToolResult(await runCodeTool(context, "context7_get_docs", input, options.abortSignal)),
    }),
  }
}

export async function runAiSdkAgentTurn(input: RunAiAgentInput) {
  const result = streamText({
    model: input.model,
    system: input.systemPrompt,
    prompt: input.prompt,
    tools: createCodeTools({
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
    }),
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    abortSignal: input.signal,
  })

  let currentStepText = ""
  let finalText = ""

  for await (const part of result.fullStream) {
    if (part.type === "start-step") {
      currentStepText = ""
      continue
    }
    if (part.type === "text-delta") {
      currentStepText += part.text
      input.onDelta?.(part.text)
      continue
    }
    if (part.type === "finish-step") {
      if (currentStepText) {
        finalText = currentStepText
      }
      continue
    }
    if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }

  return finalText
}
