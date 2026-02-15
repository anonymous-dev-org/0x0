import { Config } from "@/config/config"

export namespace SystemPrompt {
  export async function instructions() {
    const config = await Config.get()
    return (config.system_prompt ?? "").trim()
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
