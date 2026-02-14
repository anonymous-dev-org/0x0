import PROMPT_CODEX from "./prompt/codex_header.txt"
import { Config } from "@/config/config"

export namespace SystemPrompt {
  export async function instructions() {
    const config = await Config.get()
    const system = config.prompt?.system
    return (config.system_prompt ?? system?.base ?? system?.codex_instructions ?? PROMPT_CODEX).trim()
  }

  export async function compose(input: { agent?: string; skill?: string }) {
    const seen = new Set<string>()
    return [await instructions(), input.agent, input.skill].filter((item): item is string => {
      if (!item?.trim()) return false
      const key = item.trim()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
