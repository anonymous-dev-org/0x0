import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Log } from "../util/log"

import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { NamedError } from "@anonymous-dev/0x0-util/error"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Skill } from "../skill"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  export const Info = z
    .object({
      name: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      mode: z.enum(["primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.unknown()),
      steps: z.number().int().positive().optional(),
      actions: z
        .record(
          z.string(),
          z.record(z.string(), z.enum(["allow", "deny", "ask"])),
        )
        .default({}),
      thinkingEffort: z.string().optional(),
      knowledgeBase: z.array(z.string()).default([]),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.input<typeof Info>

  // Backward-compat: convert legacy tools_allowed IDs to actions
  const LEGACY_TOOL_TO_ACTIONS: Record<string, Record<string, string[]>> = {
    bash:          { "claude-code": ["Bash"],                     codex: ["commandExecution"] },
    read:          { "claude-code": ["Read"] },
    search:        { "claude-code": ["Glob", "Grep"] },
    search_remote: { "claude-code": ["WebFetch", "WebSearch"] },
    apply_patch:   { "claude-code": ["Edit", "Write", "MultiEdit", "NotebookEdit"], codex: ["fileChange"] },
    task:          { "claude-code": ["Task"] },
    todowrite:     { "claude-code": ["TodoWrite"] },
    question:      { "claude-code": ["AskUserQuestion"] },
  }

  function convertToolsAllowedToActions(toolsAllowed: string[]): Record<string, Record<string, "allow">> {
    const result: Record<string, Record<string, "allow">> = {}
    for (const tool of toolsAllowed) {
      const mapping = LEGACY_TOOL_TO_ACTIONS[tool]
      if (!mapping) continue
      for (const [provider, sdkTools] of Object.entries(mapping)) {
        if (!result[provider]) result[provider] = {}
        for (const sdkTool of sdkTools) {
          result[provider]![sdkTool] = "allow"
        }
      }
    }
    return result
  }

  // Map SDK tool names → permission keys (same as processor.ts)
  function sdkToolToPermission(toolName: string): string {
    switch (toolName) {
      case "Bash":
      case "commandExecution": return "bash"
      case "Edit":
      case "Write":
      case "MultiEdit":
      case "NotebookEdit":
      case "fileChange": return "edit"
      case "Read": return "read"
      case "Glob":
      case "Grep": return "search"
      case "Task": return "task"
      case "WebFetch":
      case "WebSearch": return "web"
      case "TodoWrite": return "todowrite"
      case "AskUserQuestion": return "question"
      default: return toolName.toLowerCase()
    }
  }

  function derivePermissionKeysFromActions(actions: Record<string, Record<string, string>>): string[] {
    const keys = new Set<string>()
    for (const tools of Object.values(actions)) {
      for (const [tool, policy] of Object.entries(tools)) {
        if (policy === "allow") keys.add(sdkToolToPermission(tool))
      }
    }
    return [...keys]
  }

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        [Truncate.GLOB]: "allow",
        ...Object.fromEntries(skillDirs.map((dir) => [path.join(dir, "*"), "allow"])),
      },
      question: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      compaction: {
        name: "compaction",
        displayName: "Compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
        knowledgeBase: [...(cfg.knowledge_base ?? [])],
      },
      title: {
        name: "title",
        displayName: "Title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
        knowledgeBase: [...(cfg.knowledge_base ?? [])],
      },
      summary: {
        name: "summary",
        displayName: "Summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
        knowledgeBase: [...(cfg.knowledge_base ?? [])],
      },
    }

    const native = new Set(["builder", "planner", "general", "explore", "compaction", "title", "summary"])

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          displayName: value.name,
          mode: native.has(key) ? "primary" : "all",
          permission: PermissionNext.merge(defaults, PermissionNext.fromConfig({ "*": "deny" }), user),
          options: {},
          native: native.has(key),
          knowledgeBase: [...(cfg.knowledge_base ?? [])],
        }

      // Backward-compat: convert tools_allowed → actions if actions not set
      if (value.tools_allowed && !value.actions) {
        log.warn(`agent "${key}": tools_allowed is deprecated — use actions instead`)
        value.actions = convertToolsAllowedToActions(value.tools_allowed)
      }

      if (key === "explore" && !value.prompt) item.prompt = PROMPT_EXPLORE

      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.displayName = value.name ?? item.displayName
      item.steps = value.steps ?? value.maxSteps ?? item.steps
      item.actions = value.actions ?? item.actions ?? {}
      item.thinkingEffort = value.thinking_effort ?? item.thinkingEffort
      item.knowledgeBase = Array.from(new Set([...(cfg.knowledge_base ?? []), ...(value.knowledge_base ?? [])]))
      item.options = mergeDeep(item.options, value.options ?? {})
      if (value.mode) item.mode = value.mode
      if (native.has(key)) {
        item.permission = PermissionNext.merge(defaults, user)
      } else {
        const permKeys = derivePermissionKeysFromActions(item.actions)
        item.permission = PermissionNext.merge(
          defaults,
          user,
          PermissionNext.fromConfig({ "*": "deny" }),
          PermissionNext.fromConfig(Object.fromEntries(permKeys.map((k) => [k, "allow" as const]))),
        )
      }

      if (value.permission) {
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig(value.permission as Parameters<typeof PermissionNext.fromConfig>[0]),
        )
      }

      if (value.tools) {
        const deny: Record<string, "deny"> = {}
        for (const [tool, allowed] of Object.entries(value.tools)) {
          if (!allowed) {
            const perm = tool === "write" || tool === "apply_patch" || tool === "multiedit" ? "edit" : tool
            deny[perm] = "deny"
          }
        }
        item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(deny))
      }

      const known = new Set([
        "name",
        "model",
        "variant",
        "temperature",
        "top_p",
        "prompt",
        "disable",
        "description",
        "hidden",
        "options",
        "color",
        "steps",
        "maxSteps",
        "tools_allowed",
        "actions",
        "thinking_effort",
        "knowledge_base",
        "mode",
        "permission",
        "tools",
      ])
      for (const [k, v] of Object.entries(value)) {
        if (!known.has(k)) item.options[k] = v
      }

      if (key === "planner") {
        const plannerPermKeys = derivePermissionKeysFromActions(item.actions)
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig({ "*": "deny" }),
          PermissionNext.fromConfig(Object.fromEntries(plannerPermKeys.map((k) => [k, "allow" as const]))),
          PermissionNext.fromConfig({
            read: { "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
            edit: { ".zeroxzero/plans/*": "allow" },
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
          }),
        )
      }
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      if (!agent) continue
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      agent.permission = PermissionNext.merge(
        agent.permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "planner"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const preferred = agents.planner
    if (preferred && preferred.hidden !== true) return preferred.name

    const visible = Object.values(agents).find((a) => a.hidden !== true)
    if (!visible) throw new Error("no visible agent found")
    return visible.name
  }

  export async function generate(
    _input: { description: string; model?: { providerID: string; modelID: string } },
  ): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }> {
    throw new NamedError.Unknown({ message: "Agent generation is not supported in CLI-delegating mode." })
  }
}
