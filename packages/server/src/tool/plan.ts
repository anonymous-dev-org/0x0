import z from "zod"
import * as fs from "fs/promises"
import * as path from "path"
import { Tool } from "./tool"
import { Bus } from "@/core/bus"
import { File } from "@/workspace/file"
import { FileWatcher } from "@/workspace/file/watcher"
import { Instance } from "../project/instance"
import { Todo } from "../session/todo"
import DESCRIPTION from "./plan.txt"

export const PlanTool = Tool.define("plan", {
  description: DESCRIPTION,
  parameters: z.object({
    filename: z
      .string()
      .describe('Filename relative to .zeroxzero/, must end in .md (e.g. "my-feature.md" or "plans/refactor.md")'),
    content: z.string().describe("Full markdown content of the plan"),
    todos: z
      .array(z.object(Todo.Info.shape))
      .describe("Structured task list. Set all to status='pending' initially."),
  }),
  async execute(params, ctx) {
    if (!params.filename.endsWith(".md")) {
      throw new Error("filename must end in .md")
    }
    if (params.filename.includes("..")) {
      throw new Error("filename must not contain path traversal (..)")
    }

    const baseDir = Instance.worktree === "/" ? Instance.directory : Instance.worktree
    const zeroxzeroDir = path.join(baseDir, ".zeroxzero")
    const resolved = path.resolve(zeroxzeroDir, params.filename)

    // Hard boundary — must stay inside .zeroxzero/
    if (!resolved.startsWith(zeroxzeroDir + path.sep) && resolved !== zeroxzeroDir) {
      throw new Error(`filename resolves outside .zeroxzero/. Got: ${params.filename}`)
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true })

    const existed = await Bun.file(resolved).exists()
    await Bun.write(resolved, params.content)

    await Todo.update({ sessionID: ctx.sessionID, todos: params.todos })

    await Bus.publish(File.Event.Edited, { file: resolved })
    await Bus.publish(FileWatcher.Event.Updated, { file: resolved, event: existed ? "change" : "add" })

    const relative = path.relative(baseDir, resolved)
    return {
      title: relative,
      output: `Plan saved to ${relative} (${params.todos.length} tasks)`,
      metadata: {
        filepath: resolved,
        todos: params.todos,
      },
    }
  },
})
