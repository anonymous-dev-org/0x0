import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { ToolRegistry } from "@/tool/registry"

export namespace Agent {
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
      toolsAllowed: z.array(z.string()).default([]),
      thinkingEffort: z.string().optional(),
      knowledgeBase: z.array(z.string()).default([]),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.input<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()
    const availableTools = new Set(await ToolRegistry.ids())

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
        toolsAllowed: [],
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
        toolsAllowed: [],
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
        toolsAllowed: [],
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
          mode: "primary",
          permission: PermissionNext.merge(defaults, PermissionNext.fromConfig({ "*": "deny" }), user),
          options: {},
          native: native.has(key),
          toolsAllowed: [],
          knowledgeBase: [...(cfg.knowledge_base ?? [])],
        }

      const toolsAllowed = value.tools_allowed
      for (const tool of toolsAllowed) {
        if (!availableTools.has(tool)) {
          throw new Error(`Unknown tool \"${tool}\" in agent \"${key}\". Update tools_allowed to valid tool IDs.`)
        }
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
      item.displayName = value.name
      item.steps = value.steps ?? item.steps
      item.toolsAllowed = [...toolsAllowed]
      item.thinkingEffort = value.thinking_effort
      item.knowledgeBase = Array.from(new Set([...(cfg.knowledge_base ?? []), ...(value.knowledge_base ?? [])]))
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(
        defaults,
        user,
        PermissionNext.fromConfig({ "*": "deny" }),
        PermissionNext.fromConfig(Object.fromEntries(toolsAllowed.map((tool) => [tool, "allow" as const]))),
      )

      if (key === "planner") {
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig({
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
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
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

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: await SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
