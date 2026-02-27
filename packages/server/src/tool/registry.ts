import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import type { Agent } from "@/runtime/agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "@/core/config/config"
import path from "path"
import z from "zod"
import { Flag } from "@/core/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { ApplyPatchTool } from "./apply_patch"
import { SearchTool } from "./search"
import { SearchRemoteTool } from "./search_remote"

interface ToolDefinition {
  description: string
  args: z.ZodRawShape
  execute: (args: any, ctx: any) => Promise<string>
}

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    const matches = await Config.directories().then((dirs) =>
      dirs.flatMap((dir) => [...glob.scanSync({ cwd: dir, absolute: true, followSymlinks: true, dot: true })]),
    )
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      const mod = await import(match)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as any
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const config = await Config.get()
    const custom = await state().then((x) => x.custom)

    return [
      ...(["app", "cli", "desktop"].includes(Flag.ZEROXZERO_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      SearchTool,
      TaskTool,
      SearchRemoteTool,
      TodoWriteTool,
      // TodoReadTool,
      ApplyPatchTool,
      ...(config.experimental?.lsp_tool ? [LspTool] : []),
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    excluded?: Set<string>,
  ) {
    const tools = await all()
    const filtered = excluded?.size ? tools.filter((t) => !excluded.has(t.id)) : tools
    const result = await Promise.all(
      filtered.map(async (t) => {
        using _ = log.time(t.id)
        return {
          id: t.id,
          ...(await t.init({ agent })),
        }
      }),
    )
    return result
  }
}
