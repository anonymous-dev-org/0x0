import z from "zod"
import { NamedError } from "@/util/error"
import { ProviderAuth } from "./auth"

export namespace Provider {
  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      name: z.string(),
      reasoning: z.boolean(),
      limit: z.object({
        context: z.number(),
        output: z.number(),
      }),
    })
    .meta({ ref: "Model" })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      models: z.record(z.string(), Model),
    })
    .meta({ ref: "Provider" })
  export type Info = z.infer<typeof Info>

  function makeModel(providerID: string, id: string, name: string, extra: Partial<Model> = {}): Model {
    return {
      id,
      providerID,
      name,
      reasoning: false,
      limit: { context: 200_000, output: 8_192 },
      ...extra,
    }
  }

  const CLAUDE_MODELS: Record<string, Model> = {
    "claude-sonnet-4-6": makeModel("claude", "claude-sonnet-4-6", "Claude Sonnet 4.6", {
      limit: { context: 200_000, output: 64_000 },
    }),
    "claude-opus-4-6": makeModel("claude", "claude-opus-4-6", "Claude Opus 4.6", {
      limit: { context: 200_000, output: 32_000 },
    }),
    "claude-haiku-4-5-20251001": makeModel("claude", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", {
      limit: { context: 200_000, output: 8_192 },
    }),
  }

  const CODEX_MODELS: Record<string, Model> = {
    "o4-mini": makeModel("codex", "o4-mini", "o4-mini", {
      reasoning: true,
      limit: { context: 200_000, output: 32_000 },
    }),
    o3: makeModel("codex", "o3", "o3", {
      reasoning: true,
      limit: { context: 200_000, output: 32_000 },
    }),
    "gpt-5-codex": makeModel("codex", "gpt-5-codex", "GPT-5 Codex", {
      reasoning: true,
      limit: { context: 400_000, output: 128_000 },
    }),
  }

  const ALL_PROVIDERS: Record<string, Info> = {
    claude: {
      id: "claude",
      name: "Claude",
      models: CLAUDE_MODELS,
    },
    codex: {
      id: "codex",
      name: "Codex",
      models: CODEX_MODELS,
    },
  }

  export function all(): Record<string, Info> {
    return ALL_PROVIDERS
  }

  export async function list(): Promise<Record<string, Info>> {
    const [claudeAvailable, codexAvailable] = await Promise.all([
      ProviderAuth.isAvailable("claude"),
      ProviderAuth.isAvailable("codex"),
    ])
    const result: Record<string, Info> = {}
    if (claudeAvailable) result["claude"] = ALL_PROVIDERS["claude"]!
    if (codexAvailable) result["codex"] = ALL_PROVIDERS["codex"]!
    return result
  }

  export async function getModel(providerID: string, modelID: string): Promise<Model> {
    const provider = ALL_PROVIDERS[providerID]
    if (!provider) throw new ModelNotFoundError({ providerID, modelID })
    const model = provider.models[modelID]
    if (!model) throw new ModelNotFoundError({ providerID, modelID })
    return model
  }

  export async function defaultProvider(): Promise<string> {
    const providers = await list()
    if (providers["claude"]) return "claude"
    if (providers["codex"]) return "codex"
    throw new Error("No providers available. Install Claude CLI or set OPENAI_API_KEY.")
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
    })
  )
}
