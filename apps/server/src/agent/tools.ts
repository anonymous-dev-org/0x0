import type { ChangedFile } from "@anonymous-dev/0x0-contracts"
import type { AgentToolDefinition } from "./types"
import { mkdir, rm } from "node:fs/promises"
import nodePath from "node:path"

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

type ToolContext = {
  repoRoot: string
  worktreePath: string
}

type ToolResult = {
  ok: boolean
  output: string
}

const MAX_TOOL_OUTPUT = 24_000

export const CODE_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "list_files",
    description: "List files in the agent worktree. Prefer this or search before reading unknown paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional directory relative to the worktree." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the agent worktree, optionally by 1-based line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search the worktree with ripgrep and return path:line matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Optional file or directory relative to the worktree." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description: "Apply an apply_patch-style patch to files in the agent worktree.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string" },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create a new small file or explicitly overwrite a small file in the agent worktree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: "Run an allowlisted shell command in the agent worktree for inspection, tests, formatters, or codegen.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Return git status for the agent worktree.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "git_diff",
    description: "Return the unstaged Git diff for the agent worktree.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "context7_resolve_library",
    description: "Resolve a library name with Context7 MCP when the server has Context7 configured.",
    inputSchema: {
      type: "object",
      properties: {
        libraryName: { type: "string" },
      },
      required: ["libraryName"],
      additionalProperties: false,
    },
  },
  {
    name: "context7_get_docs",
    description: "Fetch library documentation with Context7 MCP when the server has Context7 configured.",
    inputSchema: {
      type: "object",
      properties: {
        context7CompatibleLibraryID: { type: "string" },
        topic: { type: "string" },
        tokens: { type: "integer", minimum: 1000 },
      },
      required: ["context7CompatibleLibraryID"],
      additionalProperties: false,
    },
  },
]

function truncate(value: string) {
  if (value.length <= MAX_TOOL_OUTPUT) {
    return value
  }
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n\n[truncated ${value.length - MAX_TOOL_OUTPUT} chars]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringArg(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string") {
    throw new Error(`Missing string argument: ${key}`)
  }
  return value
}

function optionalStringArg(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string argument: ${key}`)
  }
  return value
}

function optionalLineArg(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`Expected positive integer argument: ${key}`)
  }
  return Number(value)
}

function resolveInside(root: string, requestedPath = ".") {
  const resolved = nodePath.resolve(root, requestedPath)
  const relative = nodePath.relative(root, resolved)
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw new Error(`Path escapes worktree: ${requestedPath}`)
  }
  return resolved
}

async function runCommand(args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Operation cancelled.")
  }
}

function formatCommandResult(result: CommandResult) {
  return truncate(
    [
      `exit: ${result.code}`,
      result.stdout ? `stdout:\n${result.stdout}` : undefined,
      result.stderr ? `stderr:\n${result.stderr}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
}

async function readFileTool(context: ToolContext, input: Record<string, unknown>) {
  const path = stringArg(input, "path")
  const startLine = optionalLineArg(input, "startLine")
  const endLine = optionalLineArg(input, "endLine")
  const filePath = resolveInside(context.worktreePath, path)
  const content = await Bun.file(filePath).text()
  const lines = content.split("\n")

  if (startLine === undefined && endLine === undefined) {
    return truncate(content)
  }

  const start = startLine ?? 1
  const end = endLine ?? lines.length
  if (end < start) {
    throw new Error("endLine must be greater than or equal to startLine.")
  }

  return truncate(
    lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n"),
  )
}

async function listFilesTool(context: ToolContext, input: Record<string, unknown>, signal?: AbortSignal) {
  const path = optionalStringArg(input, "path") ?? "."
  const resolved = resolveInside(context.worktreePath, path)
  const relative = nodePath.relative(context.worktreePath, resolved) || "."
  const result = await runCommand(["rg", "--files", relative], context.worktreePath, signal)
  return formatCommandResult(result)
}

async function searchTool(context: ToolContext, input: Record<string, unknown>, signal?: AbortSignal) {
  const pattern = stringArg(input, "pattern")
  const path = optionalStringArg(input, "path") ?? "."
  const resolved = resolveInside(context.worktreePath, path)
  const relative = nodePath.relative(context.worktreePath, resolved) || "."
  const result = await runCommand(["rg", "-n", "--hidden", "--glob", "!.git", pattern, relative], context.worktreePath, signal)
  if (result.code === 1 && !result.stdout) {
    return "No matches."
  }
  return formatCommandResult(result)
}

function parseApplyPatch(patch: string) {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch")
  }
  const operations: Array<
    | { type: "add"; path: string; content: string }
    | { type: "delete"; path: string }
    | { type: "update"; path: string; hunks: Array<{ oldLines: string[]; newLines: string[] }> }
  > = []
  let index = 1

  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch") {
      return operations
    }
    if (line?.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length)
      index += 1
      const content: string[] = []
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const addLine = lines[index] ?? ""
        if (!addLine.startsWith("+")) {
          throw new Error(`Add file lines must start with + in ${path}`)
        }
        content.push(addLine.slice(1))
        index += 1
      }
      operations.push({ type: "add", path, content: content.join("\n") })
      continue
    }
    if (line?.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: line.slice("*** Delete File: ".length) })
      index += 1
      continue
    }
    if (line?.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length)
      index += 1
      const hunks: Array<{ oldLines: string[]; newLines: string[] }> = []
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        if (!lines[index]?.startsWith("@@")) {
          index += 1
          continue
        }
        index += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        while (index < lines.length && !lines[index]?.startsWith("@@") && !lines[index]?.startsWith("*** ")) {
          const hunkLine = lines[index] ?? ""
          const marker = hunkLine[0]
          const value = hunkLine.slice(1)
          if (marker === " ") {
            oldLines.push(value)
            newLines.push(value)
          } else if (marker === "-") {
            oldLines.push(value)
          } else if (marker === "+") {
            newLines.push(value)
          } else if (hunkLine === "") {
            oldLines.push("")
            newLines.push("")
          } else {
            throw new Error(`Unsupported patch line in ${path}: ${hunkLine}`)
          }
          index += 1
        }
        hunks.push({ oldLines, newLines })
      }
      operations.push({ type: "update", path, hunks })
      continue
    }
    throw new Error(`Unsupported patch header: ${line}`)
  }

  throw new Error("Patch must end with *** End Patch")
}

async function applyPatchTool(context: ToolContext, input: Record<string, unknown>) {
  const patch = stringArg(input, "patch")
  const operations = parseApplyPatch(patch)

  for (const operation of operations) {
    const target = resolveInside(context.worktreePath, operation.path)
    if (operation.type === "add") {
      if (await Bun.file(target).exists()) {
        throw new Error(`File already exists: ${operation.path}`)
      }
      await mkdir(nodePath.dirname(target), { recursive: true })
      await Bun.write(target, operation.content)
      continue
    }
    if (operation.type === "delete") {
      await rm(target)
      continue
    }

    let content = await Bun.file(target).text()
    let lines = content.split("\n")
    const hadTrailingNewline = content.endsWith("\n")
    if (hadTrailingNewline) {
      lines = lines.slice(0, -1)
    }
    for (const hunk of operation.hunks) {
      const oldText = hunk.oldLines.join("\n")
      const currentText = lines.join("\n")
      const offset = currentText.indexOf(oldText)
      if (offset === -1) {
        throw new Error(`Patch context not found in ${operation.path}`)
      }
      content = `${currentText.slice(0, offset)}${hunk.newLines.join("\n")}${currentText.slice(offset + oldText.length)}`
      lines = content.split("\n")
    }
    await Bun.write(target, `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`)
  }

  return `Applied ${operations.length} patch operation(s).`
}

async function writeFileTool(context: ToolContext, input: Record<string, unknown>) {
  const path = stringArg(input, "path")
  const content = stringArg(input, "content")
  const overwrite = input.overwrite === true
  const target = resolveInside(context.worktreePath, path)
  const exists = await Bun.file(target).exists()
  if (exists && !overwrite) {
    throw new Error(`File already exists. Set overwrite=true to replace: ${path}`)
  }
  if (content.length > 80_000) {
    throw new Error("write_file content is too large for the V1 tool contract.")
  }
  await mkdir(nodePath.dirname(target), { recursive: true })
  await Bun.write(target, content)
  return `${exists ? "Updated" : "Created"} ${path}`
}

function isAllowedBash(command: string) {
  const forbidden = [
    /\bsed\s+-i\b/,
    /\bperl\s+-pi\b/,
    /\bgit\s+commit\b/,
    /\bgit\s+reset\b/,
    /\bgit\s+checkout\b/,
    /\bgit\s+clean\b/,
    /\brm\s+-rf\b/,
    /(^|[\s"'`])\/[^\s"'`]*/,
    /(^|[\s"'`])\.\.(\/|$)/,
    /[`$]/,
  ]
  if (forbidden.some((pattern) => pattern.test(command))) {
    return false
  }
  const trimmed = command.trim()
  return /^(rg|grep|find|ls|pwd|sed|awk|cat|head|tail|wc|git status|git diff|bun|npm|pnpm|yarn|cargo|go|python|python3|node|tsc|deno)\b/.test(trimmed)
}

async function bashTool(context: ToolContext, input: Record<string, unknown>, signal?: AbortSignal) {
  const command = stringArg(input, "command")
  if (!isAllowedBash(command)) {
    throw new Error(`Command is not allowed by the V1 bash policy: ${command}`)
  }
  const result = await runCommand(["/bin/zsh", "-lc", command], context.worktreePath, signal)
  return formatCommandResult(result)
}

async function context7Tool(name: string) {
  return [
    `${name} is available in the V1 tool contract, but no Context7 MCP process is configured in this server build yet.`,
    "Set up a server-side MCP adapter for Context7 before relying on this tool for live docs.",
  ].join("\n")
}

export async function runCodeTool(
  context: ToolContext,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    throwIfAborted(signal)
    if (!isRecord(input)) {
      throw new Error("Tool input must be an object.")
    }

    switch (name) {
      case "list_files":
        return { ok: true, output: await listFilesTool(context, input, signal) }
      case "read_file":
        return { ok: true, output: await readFileTool(context, input) }
      case "search":
        return { ok: true, output: await searchTool(context, input, signal) }
      case "apply_patch":
        return { ok: true, output: await applyPatchTool(context, input) }
      case "write_file":
        return { ok: true, output: await writeFileTool(context, input) }
      case "bash":
        return { ok: true, output: await bashTool(context, input, signal) }
      case "git_status":
        return { ok: true, output: formatCommandResult(await runCommand(["git", "status", "--short"], context.worktreePath, signal)) }
      case "git_diff":
        return { ok: true, output: formatCommandResult(await runCommand(["git", "diff"], context.worktreePath, signal)) }
      case "context7_resolve_library":
      case "context7_get_docs":
        return { ok: false, output: await context7Tool(name) }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}

export function parseNameStatus(output: string): ChangedFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [statusCode = "", firstPath = "", secondPath] = line.split(/\s+/)
      const status = statusCode.startsWith("A")
        ? "added"
        : statusCode.startsWith("D")
          ? "deleted"
          : statusCode.startsWith("R")
            ? "renamed"
            : "modified"
      return {
        path: secondPath ?? firstPath,
        status,
      } satisfies ChangedFile
    })
}
