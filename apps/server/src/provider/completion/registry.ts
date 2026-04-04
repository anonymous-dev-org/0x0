import type { CompletionProvider } from "./types"
import { AnthropicCompletionProvider } from "./anthropic"
import { OpenAICompletionProvider } from "./openai"
import { Log } from "@/util/log"

const log = Log.create({ service: "completion:registry" })

const providers: CompletionProvider[] = [
  new AnthropicCompletionProvider(),
  new OpenAICompletionProvider(),
]

export namespace CompletionRegistry {
  export async function resolve(
    id?: string,
  ): Promise<CompletionProvider> {
    if (id) {
      const provider = providers.find((p) => p.id === id)
      if (!provider) {
        throw new Error(
          `Unknown completion provider: ${id}. Available: ${providers.map((p) => p.id).join(", ")}`,
        )
      }
      if (!(await provider.isAvailable())) {
        throw new Error(
          `Completion provider "${id}" is not available. Check that the required API key is set.`,
        )
      }
      return provider
    }

    // Auto-detect first available
    for (const provider of providers) {
      if (await provider.isAvailable()) {
        log.info("auto-detected", { provider: provider.id })
        return provider
      }
    }

    throw new Error(
      `No completion provider available. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY`,
    )
  }

  export async function list(): Promise<
    { id: string; name: string; available: boolean }[]
  > {
    return Promise.all(
      providers.map(async (p) => ({
        id: p.id,
        name: p.name,
        available: await p.isAvailable(),
      })),
    )
  }
}
