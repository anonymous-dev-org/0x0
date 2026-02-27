import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./search.txt"
import { Ripgrep } from "@/workspace/file/ripgrep"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000
const LIMIT = 100
type Metadata = {
  mode: "files" | "content"
  count?: number
  matches?: number
  truncated: boolean
}

const Schema = z
  .object({
    mode: z.enum(["files", "content"]),
    pattern: z.string().describe('Search pattern. Use glob for mode="files" and regex for mode="content".'),
    include: z.string().optional().describe('Optional file filter glob (only for mode="content").'),
    path: z.string().optional().describe("Directory root to search in. Defaults to current working directory."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "files" && value.include !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["include"],
        message: 'include is only valid when mode is "content"',
      })
    }
  })

export const SearchTool = Tool.define<typeof Schema, Metadata>("search", {
  description: DESCRIPTION,
  parameters: Schema,
  async execute(params, ctx) {
    const search = await normalize(params.path, ctx)

    if (params.mode === "files") {
      await ctx.ask({
        permission: "search",
        patterns: [params.pattern],
        always: ["*"],
        metadata: {
          mode: params.mode,
          pattern: params.pattern,
          path: params.path,
        },
      })

      const files = [] as { path: string; mtime: number }[]
      let truncated = false
      for await (const file of Ripgrep.files({
        cwd: search,
        glob: [params.pattern],
        signal: ctx.abort,
      })) {
        if (files.length >= LIMIT) {
          truncated = true
          break
        }
        const full = path.resolve(search, file)
        const mtime = await Bun.file(full)
          .stat()
          .then((x) => x.mtime.getTime())
          .catch(() => 0)
        files.push({ path: full, mtime })
      }

      files.sort((a, b) => b.mtime - a.mtime)

      const output = [] as string[]
      if (files.length === 0) output.push("No files found")
      if (files.length > 0) output.push(...files.map((x) => x.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }

      return {
        title: path.relative(Instance.worktree, search),
        metadata: {
          mode: params.mode,
          count: files.length,
          truncated,
        },
        output: output.join("\n"),
      }
    }

    await ctx.ask({
      permission: "search",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        mode: params.mode,
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) args.push("--glob", params.include)
    args.push(search)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })

    const output = await new Response(proc.stdout).text()
    const errors = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code === 1 || (code === 2 && !output.trim())) {
      return {
        title: params.pattern,
        metadata: {
          mode: params.mode,
          matches: 0,
          truncated: false,
        },
        output: "No files found",
      }
    }
    if (code !== 0 && code !== 2) throw new Error(`ripgrep failed: ${errors}`)

    const lines = output.trim().split(/\r?\n/)
    const matches = await Promise.all(
      lines.flatMap(async (line) => {
        if (!line) return [] as never[]
        const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
        if (!filePath || !lineNumStr || lineTextParts.length === 0) return [] as never[]

        const lineNum = Number.parseInt(lineNumStr, 10)
        const stat = await Bun.file(filePath)
          .stat()
          .catch(() => undefined)
        if (!stat) return [] as never[]
        return [
          {
            path: filePath,
            mtime: stat.mtime.getTime(),
            lineNum,
            lineText: lineTextParts.join("|"),
          },
        ]
      }),
    ).then((x) => x.flat())

    matches.sort((a, b) => b.mtime - a.mtime)
    const truncated = matches.length > LIMIT
    const final = truncated ? matches.slice(0, LIMIT) : matches
    if (final.length === 0) {
      return {
        title: params.pattern,
        metadata: {
          mode: params.mode,
          matches: 0,
          truncated: false,
        },
        output: "No files found",
      }
    }

    const out = [`Found ${final.length} matches`] as string[]
    let file = ""
    for (const item of final) {
      if (file !== item.path) {
        if (file) out.push("")
        file = item.path
        out.push(`${item.path}:`)
      }
      const line =
        item.lineText.length > MAX_LINE_LENGTH ? item.lineText.slice(0, MAX_LINE_LENGTH) + "..." : item.lineText
      out.push(`  Line ${item.lineNum}: ${line}`)
    }
    if (truncated) {
      out.push("")
      out.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }
    if (code === 2) {
      out.push("")
      out.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: params.pattern,
      metadata: {
        mode: params.mode,
        matches: final.length,
        truncated,
      },
      output: out.join("\n"),
    }
  },
})

async function normalize(input: string | undefined, ctx: Tool.Context) {
  const search = path.isAbsolute(input ?? Instance.directory)
    ? (input ?? Instance.directory)
    : path.resolve(Instance.directory, input ?? Instance.directory)
  await assertExternalDirectory(ctx, search, { kind: "directory" })
  return search
}
