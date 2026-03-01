import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WriteTool } from "./write"
import { EditTool } from "./edit"
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
import { DocsTool } from "./docs"

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
      WriteTool,
      EditTool,
      SearchTool,
      TaskTool,
      SearchRemoteTool,
      TodoWriteTool,
      // TodoReadTool,
      ApplyPatchTool,
      ...(config.experimental?.lsp_tool ? [LspTool] : []),
      ...(config.experimental?.context7_api_key ? [DocsTool] : []),
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  const SDK_NAME_TO_REGISTRY_ID: Record<string, string> = {
    Bash: "bash",
    Read: "read",
    Write: "write",
    Edit: "edit",
    Glob: "search",
    Grep: "search",
    Task: "task",
    WebFetch: "search_remote",
    WebSearch: "search_remote",
    TodoWrite: "todo_write",
    AskUserQuestion: "question",
    ApplyPatch: "apply_patch",
    Lsp: "lsp",
    Docs: "docs",
  }

  // Returns null if no actions config → pass all tools.
  // Returns a Set of registry IDs → only those tools are allowed.
  function deriveAllowed(agent?: Agent.Info): Set<string> | null {
    const actions = agent?.actions
    if (!actions || Object.keys(actions).length === 0) return null
    const allowed = new Set<string>()
    for (const [toolName, policy] of Object.entries(actions)) {
      if (policy === "allow" || policy === "ask") {
        allowed.add(SDK_NAME_TO_REGISTRY_ID[toolName] ?? toolName.toLowerCase())
      }
    }
    return allowed
  }

  export async function tools(
    model: { providerID: string; modelID: string },
    agent?: Agent.Info,
    excluded?: Set<string>,
  ) {
    const allowedSet = deriveAllowed(agent)
    const list = await all()
    const filtered = list.filter((t) => {
      if (allowedSet !== null && !allowedSet.has(t.id)) return false
      if (excluded?.has(t.id)) return false
      return true
    })
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
