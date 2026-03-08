import path from "path"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import z from "zod"
import { Config } from "@/core/config/config"
import { Global } from "@/core/global"
import { Skill } from "@/integration/skill"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Truncate } from "@/tool/truncation"
import { NamedError } from "@/util/error"
import { Log } from "@/util/log"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  export const Mode = Config.AgentMode
  export type Mode = Config.AgentMode

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
      modePrompt: z.string().optional(),
      options: z.record(z.string(), z.unknown()),
      steps: z.number().int().positive().optional(),
      actions: z.record(z.string(), z.enum(["allow", "deny", "ask"])).default({}),
      thinkingEffort: z.string().optional(),
      knowledgeBase: z.array(z.string()).default([]),
      agentMode: Mode.optional(),
      modes: z.array(Mode).default([]),
      overrides: z.array(Config.AgentOverride).default([]),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.input<typeof Info>

  // Backward-compat: convert legacy tools_allowed IDs to actions
  const LEGACY_TOOL_TO_ACTIONS: Record<string, string[]> = {
    bash: ["Bash"],
    read: ["Read"],
    search: ["Glob", "Grep"],
    search_remote: ["WebFetch", "WebSearch"],
    apply_patch: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    task: ["Task"],
    todowrite: ["TodoWrite"],
    question: ["AskUserQuestion"],
    plan: ["Plan"],
  }

  function convertToolsAllowedToActions(toolsAllowed: string[]): Record<string, "allow"> {
    const result: Record<string, "allow"> = {}
    for (const tool of toolsAllowed) {
      const mapping = LEGACY_TOOL_TO_ACTIONS[tool]
      if (!mapping) continue
      for (const name of mapping) {
        result[name] = "allow"
      }
    }
    return result
  }

  /**
   * If actions still uses the legacy nested `{ providerID: { tool: policy } }` format,
   * flatten it to `{ tool: policy }` and warn.
   */
  function migrateNestedActions(
    agentKey: string,
    actions: Record<string, unknown>
  ): Record<string, "allow" | "deny" | "ask"> {
    const flat: Record<string, "allow" | "deny" | "ask"> = {}
    let migrated = false
    for (const [key, val] of Object.entries(actions)) {
      if (typeof val === "string") {
        // Already flat
        flat[key] = val as "allow" | "deny" | "ask"
      } else if (typeof val === "object" && val !== null) {
        // Nested: val is a provider's tool map
        migrated = true
        for (const [tool, policy] of Object.entries(val as Record<string, string>)) {
          flat[tool] = policy as "allow" | "deny" | "ask"
        }
      }
    }
    if (migrated) {
      log.warn(`agent "${agentKey}": nested per-provider actions format is deprecated — use flat format instead`)
    }
    return flat
  }

  // Map tool names → permission keys
  function toolToPermission(toolName: string): string {
    switch (toolName) {
      case "Bash":
        return "bash"
      case "Edit":
      case "Write":
      case "MultiEdit":
      case "NotebookEdit":
      case "ApplyPatch":
        return "edit"
      case "Read":
        return "read"
      case "Glob":
      case "Grep":
        return "search"
      case "Task":
        return "task"
      case "WebFetch":
      case "WebSearch":
        return "search_remote"
      case "TodoWrite":
        return "todowrite"
      case "AskUserQuestion":
        return "question"
      case "Plan":
        return "plan"
      default:
        return toolName.toLowerCase()
    }
  }

  const ALL_KNOWN_ACTIONS = [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "ApplyPatch",
    "Glob",
    "Grep",
    "Task",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "AskUserQuestion",
    "Plan",
    "Docs",
    "Lsp",
  ] as const

  const ALL_PERMISSION_KEYS = [...new Set(ALL_KNOWN_ACTIONS.map(toolToPermission))]

  function derivePermissionKeysFromActions(actions: Record<string, string>): string[] {
    const keys = new Set<string>()
    for (const [tool, policy] of Object.entries(actions)) {
      if (policy === "allow") keys.add(toolToPermission(tool))
    }
    return [...keys]
  }

  const state = Instance.state(async () => {
    // Clear resolve cache whenever state reloads (config change, etc.)
    resolveCache = new Map()

    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        [Truncate.GLOB]: "allow",
        ...Object.fromEntries(skillDirs.map(dir => [path.join(dir, "*"), "allow"])),
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
          user
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
          user
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
          user
        ),
        prompt: PROMPT_SUMMARY,
        knowledgeBase: [...(cfg.knowledge_base ?? [])],
      },
    }

    const native = new Set(["default", "builder", "planner", "general", "explore", "compaction", "title", "summary"])

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

      // Backward-compat: migrate nested per-provider actions to flat format
      if (value.actions) {
        value.actions = migrateNestedActions(key, value.actions as Record<string, unknown>)
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
      item.actions = (value.actions as Record<string, "allow" | "deny" | "ask"> | undefined) ?? item.actions ?? {}
      item.thinkingEffort = value.thinking_effort ?? item.thinkingEffort
      item.knowledgeBase = Array.from(new Set([...(cfg.knowledge_base ?? []), ...(value.knowledge_base ?? [])]))
      item.options = mergeDeep(item.options, value.options ?? {})
      if (value.mode) item.mode = value.mode
      if (native.has(key)) {
        item.permission = PermissionNext.merge(defaults, user)
      } else {
        const permKeys = derivePermissionKeysFromActions(item.actions ?? {})
        item.permission = PermissionNext.merge(
          defaults,
          user,
          PermissionNext.fromConfig({ "*": "deny" }),
          PermissionNext.fromConfig(Object.fromEntries(permKeys.map(k => [k, "allow" as const])))
        )
      }

      if (value.permission) {
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig(value.permission as Parameters<typeof PermissionNext.fromConfig>[0])
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

      // Store modes supported by this agent
      const availableModes: Mode[] = []
      if (value.plan) availableModes.push("plan")
      if (value.build) availableModes.push("build")
      item.modes = availableModes
      item.overrides = (value.overrides ?? []) as Config.AgentOverride[]

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
        "plan",
        "build",
        "overrides",
      ])
      for (const [k, v] of Object.entries(value)) {
        if (!known.has(k)) item.options[k] = v
      }

      // Backward compat: builder-specific permission narrowing
      if (key === "builder") {
        const builderPermKeys = new Set(derivePermissionKeysFromActions(item.actions ?? {}))
        const allPermKeys = ALL_PERMISSION_KEYS
        const denyKeys = allPermKeys.filter(k => !builderPermKeys.has(k))
        if (denyKeys.length > 0) {
          item.permission = PermissionNext.merge(
            item.permission,
            PermissionNext.fromConfig(Object.fromEntries(denyKeys.map(k => [k, "deny" as const])))
          )
        }
      }

      // Backward compat: planner-specific permission narrowing
      if (key === "planner") {
        const plannerPermKeys = derivePermissionKeysFromActions(item.actions ?? {})
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig({ "*": "deny" }),
          PermissionNext.fromConfig(Object.fromEntries(plannerPermKeys.map(k => [k, "allow" as const]))),
          PermissionNext.fromConfig({
            read: { "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
            edit: { ".zeroxzero/plans/*": "allow" },
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
          })
        )
      }

      // Default agent with modes: the base agent gets a permissive default.
      // Mode-specific permissions are resolved at runtime via Agent.resolve().
      if (key === "default" && availableModes.length > 0 && !value.actions) {
        // For the base agent (before mode resolution), allow the union of all mode actions
        // so the base agent can be used before a mode is selected.
        // The mode resolution will narrow permissions down to the active mode.
      }
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      if (!agent) continue
      const explicit = agent.permission.some(r => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      agent.permission = PermissionNext.merge(
        agent.permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } })
      )
    }

    return result
  })

  // ─── Override resolution ──────────────────────────────────────────────────

  /**
   * Score an override entry against the current context.
   * Higher score = more specific match.
   * Returns 0 if the entry doesn't match.
   */
  function scoreOverride(
    entry: Config.AgentOverride,
    ctx: { providerID?: string; modelID?: string; thinkingEffort?: string }
  ): number {
    let score = 0
    const hasProvider = !!entry.provider
    const hasModel = !!entry.model
    const hasEffort = !!entry.thinking_effort

    if (hasProvider) {
      if (entry.provider !== ctx.providerID) return 0
      score += 4
    }
    if (hasModel) {
      if (entry.model !== ctx.modelID) return 0
      score += 2
    }
    if (hasEffort) {
      if (entry.thinking_effort !== ctx.thinkingEffort) return 0
      score += 1
    }
    // An entry with no criteria is a fallback — always matches but scores 0
    if (!hasProvider && !hasModel && !hasEffort) return 0
    return score
  }

  /** Pick the best matching override from a list, or undefined if none match. */
  function bestOverride(
    overrides: Config.AgentOverride[],
    ctx: { providerID?: string; modelID?: string; thinkingEffort?: string }
  ): Config.AgentOverride | undefined {
    let best: Config.AgentOverride | undefined
    let bestScore = 0
    for (const entry of overrides) {
      const s = scoreOverride(entry, ctx)
      if (s > bestScore) {
        bestScore = s
        best = entry
      }
    }
    return best
  }

  /** Apply override fields onto an agent Info (replace semantics, not merge). */
  function applyOverride(base: Info, override: Config.AgentOverride): void {
    if (override.prompt !== undefined) base.prompt = override.prompt
    if (override.model !== undefined) base.model = Provider.parseModel(override.model)
    if (override.variant !== undefined) base.variant = override.variant
    if (override.temperature !== undefined) base.temperature = override.temperature
    if (override.top_p !== undefined) base.topP = override.top_p
    if (override.description !== undefined) base.description = override.description
    if (override.steps !== undefined) base.steps = override.steps
    if (override.maxSteps !== undefined) base.steps = override.maxSteps
    if (override.thinking_effort !== undefined) base.thinkingEffort = override.thinking_effort
    if (override.knowledge_base !== undefined) base.knowledgeBase = [...override.knowledge_base]
    if (override.actions !== undefined) {
      base.actions = migrateNestedActions("override", override.actions as Record<string, unknown>)
    }
    if (override.permission !== undefined) {
      base.permission = PermissionNext.merge(
        base.permission,
        PermissionNext.fromConfig(override.permission as Parameters<typeof PermissionNext.fromConfig>[0])
      )
    }
    if (override.options !== undefined) base.options = mergeDeep(base.options, override.options)
  }

  /** Apply a mode config on top of a base agent. */
  function applyModeConfig(base: Info, modeConfig: Config.AgentModeConfig): void {
    if (modeConfig.prompt !== undefined) base.prompt = modeConfig.prompt
    if (modeConfig.mode_prompt !== undefined) base.modePrompt = modeConfig.mode_prompt
    if (modeConfig.model !== undefined) base.model = Provider.parseModel(modeConfig.model)
    if (modeConfig.variant !== undefined) base.variant = modeConfig.variant
    if (modeConfig.temperature !== undefined) base.temperature = modeConfig.temperature
    if (modeConfig.top_p !== undefined) base.topP = modeConfig.top_p
    if (modeConfig.description !== undefined) base.description = modeConfig.description
    if (modeConfig.steps !== undefined) base.steps = modeConfig.steps
    if (modeConfig.maxSteps !== undefined) base.steps = modeConfig.maxSteps
    if (modeConfig.thinking_effort !== undefined) base.thinkingEffort = modeConfig.thinking_effort
    if (modeConfig.knowledge_base !== undefined) {
      base.knowledgeBase = Array.from(new Set([...base.knowledgeBase, ...modeConfig.knowledge_base]))
    }
    if (modeConfig.actions !== undefined) {
      base.actions = migrateNestedActions("mode", modeConfig.actions as Record<string, unknown>)
    }
    if (modeConfig.permission !== undefined) {
      base.permission = PermissionNext.merge(
        base.permission,
        PermissionNext.fromConfig(modeConfig.permission as Parameters<typeof PermissionNext.fromConfig>[0])
      )
    }
    if (modeConfig.options !== undefined) base.options = mergeDeep(base.options, modeConfig.options)
  }

  // Memoization cache for resolved agents: keyed by "agentName:mode:providerID:modelID:thinkingEffort"
  let resolveCache = new Map<string, Info>()

  /**
   * Resolve an agent with optional mode and provider/model context.
   * Returns a fully resolved Agent.Info for the active mode.
   * Result is cached per (agent, mode, provider, model, thinkingEffort) tuple.
   */
  export async function resolve(input: {
    agent: string
    agentMode?: Mode
    providerID?: string
    modelID?: string
    thinkingEffort?: string
  }): Promise<Info | undefined> {
    const cacheKey = `${input.agent}:${input.agentMode ?? ""}:${input.providerID ?? ""}:${input.modelID ?? ""}:${input.thinkingEffort ?? ""}`
    const cached = resolveCache.get(cacheKey)
    if (cached) return cached

    const base = await get(input.agent)
    if (!base) return undefined

    // If no mode requested and no overrides, return as-is
    if (!input.agentMode && !base.overrides?.length && !input.providerID) {
      return base
    }

    // Clone to avoid mutating the cached base
    const resolved: Info = JSON.parse(JSON.stringify(base))
    const ctx = {
      providerID: input.providerID,
      modelID: input.modelID,
      thinkingEffort: input.thinkingEffort,
    }

    // 1. Apply agent-level overrides
    if (resolved.overrides?.length) {
      const match = bestOverride(resolved.overrides, ctx)
      if (match) applyOverride(resolved, match)
    }

    // 2. Apply mode config
    const cfg = await Config.get()
    const agentCfg = cfg.agent?.[input.agent]
    if (input.agentMode && agentCfg) {
      const modeConfig = agentCfg[input.agentMode] as Config.AgentModeConfig | undefined
      if (modeConfig) {
        applyModeConfig(resolved, modeConfig)
        resolved.agentMode = input.agentMode

        // 3. Apply mode-level overrides
        if (modeConfig.overrides?.length) {
          const modeMatch = bestOverride(modeConfig.overrides, ctx)
          if (modeMatch) applyOverride(resolved, modeMatch)
        }
      }
    }

    resolveCache.set(cacheKey, resolved)
    return resolved
  }

  export async function get(agent: string) {
    return state().then(x => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([x => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "default"), "desc"])
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

    // Prefer "default" agent, fall back to "planner" for backward compat, then first visible
    for (const preferred of ["default", "planner"]) {
      const agent = agents[preferred]
      if (agent && agent.hidden !== true) return agent.name
    }

    const visible = Object.values(agents).find(a => a.hidden !== true)
    if (!visible) throw new Error("no visible agent found")
    return visible.name
  }

  export async function generate(_input: {
    description: string
    model?: { providerID: string; modelID: string }
  }): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }> {
    throw new NamedError.Unknown({ message: "Agent generation is not supported in CLI-delegating mode." })
  }
}
