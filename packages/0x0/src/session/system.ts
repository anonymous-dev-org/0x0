import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import { Config } from "@/config/config"

export namespace SystemPrompt {
  function knowledge(config: Config.Info) {
    if (!config.knowledge?.length) return
    return ["Project knowledge base:", ...config.knowledge.map((entry, index) => `${index + 1}. ${entry}`)].join("\n")
  }

  export async function instructions() {
    const config = await Config.get()
    const system = config.prompt?.system
    return (system?.base ?? system?.codex_instructions ?? PROMPT_CODEX).trim()
  }

  export async function models(model: Provider.Model) {
    const config = await Config.get()
    const system = config.prompt?.system
    const models = config.prompt?.models
    if (model.api.id.includes("gpt-5")) return [models?.gpt5 ?? system?.gpt5 ?? ""]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [models?.openai ?? system?.openai ?? PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [models?.gemini ?? system?.gemini ?? PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [models?.claude ?? system?.claude ?? PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [models?.trinity ?? system?.trinity ?? PROMPT_TRINITY]
    return [models?.fallback ?? system?.fallback ?? PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function compose(input: { model: Provider.Model; agent?: string }) {
    const config = await Config.get()
    const seen = new Set<string>()
    return [await instructions(), input.agent, ...(await models(input.model)), knowledge(config)].filter(
      (item): item is string => {
        if (!item) return false
        const key = item.trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
    )
  }

  export const model = models
  export const provider = models

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }
}
