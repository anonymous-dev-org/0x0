import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { sortBy } from "remeda"
import { NamedError } from "@anonymous-dev/0x0-util/error"
import { ProviderAuth } from "./auth"

export namespace Provider {

  // ─────────────────────────────────────────────────────────────────────────────
  // Types
  // ─────────────────────────────────────────────────────────────────────────────

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      name: z.string(),
      reasoning: z.boolean(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  // ─────────────────────────────────────────────────────────────────────────────
  // Hardcoded model definitions
  // ─────────────────────────────────────────────────────────────────────────────

  function makeModel(providerID: string, id: string, name: string, extra: Partial<Model> = {}): Model {
    return {
      id,
      providerID,
      name,
      reasoning: false,
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: { context: 200_000, output: 8_192 },
      ...extra,
    }
  }

  const CLAUDE_CODE_MODELS: Record<string, Model> = {
    "claude-sonnet-4-6": makeModel("claude-code", "claude-sonnet-4-6", "Claude Sonnet 4.6", {
      limit: { context: 200_000, output: 64_000 },
    }),
    "claude-opus-4-6": makeModel("claude-code", "claude-opus-4-6", "Claude Opus 4.6", {
      limit: { context: 200_000, output: 32_000 },
    }),
    "claude-haiku-4-5-20251001": makeModel("claude-code", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", {
      limit: { context: 200_000, output: 8_192 },
    }),
  }

  const CODEX_MODELS: Record<string, Model> = {
    "gpt-5-codex": makeModel("codex", "gpt-5-codex", "GPT-5 Codex", {
      reasoning: true,
      limit: { context: 400_000, input: 272_000, output: 128_000 },
    }),
    o3: makeModel("codex", "o3", "o3", {
      reasoning: true,
      limit: { context: 200_000, output: 32_000 },
    }),
    "o4-mini": makeModel("codex", "o4-mini", "o4-mini", {
      reasoning: true,
      limit: { context: 200_000, output: 32_000 },
    }),
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Static provider registry
  // ─────────────────────────────────────────────────────────────────────────────

  const ALL_PROVIDERS: Record<string, Info> = {
    "claude-code": {
      id: "claude-code",
      name: "Claude Code",
      models: CLAUDE_CODE_MODELS,
    },
    codex: {
      id: "codex",
      name: "Codex",
      models: CODEX_MODELS,
    },
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /** Returns all known providers regardless of whether they are installed. */
  export function all(): Record<string, Info> {
    return ALL_PROVIDERS
  }

  /** Returns only providers whose CLI binary is on PATH. */
  export async function list(): Promise<Record<string, Info>> {
    const [claudeAvailable, codexAvailable] = await Promise.all([
      ProviderAuth.isAvailable("claude-code"),
      ProviderAuth.isAvailable("codex"),
    ])
    const result: Record<string, Info> = {}
    if (claudeAvailable) result["claude-code"] = ALL_PROVIDERS["claude-code"]!
    if (codexAvailable) result["codex"] = ALL_PROVIDERS["codex"]!
    return result
  }

  export async function getProvider(providerID: string): Promise<Info | undefined> {
    const providers = await list()
    return providers[providerID]
  }

  export async function getModel(providerID: string, modelID: string): Promise<Model> {
    const providers = await list()
    const provider = providers[providerID]
    if (!provider) {
      const suggestions = fuzzysort
        .go(providerID, Object.keys(providers), { limit: 3, threshold: -10000 })
        .map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    const model = provider.models[modelID]
    if (!model) {
      const suggestions = fuzzysort
        .go(modelID, Object.keys(provider.models), { limit: 3, threshold: -10000 })
        .map((m) => `${providerID}/${m.target}`)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return model
  }

  export async function closest(
    providerID: string,
    query: string[],
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    const providers = await list()
    const provider = providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item)) return { providerID, modelID }
      }
    }
    return undefined
  }

  export async function getSmallModel(providerID: string): Promise<Model | undefined> {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID).catch(() => undefined)
    }

    const provider = await getProvider(providerID)
    if (!provider) return undefined

    const priority = ["haiku", "mini", "nano"]
    for (const keyword of priority) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(keyword)) return provider.models[modelID]
      }
    }

    return undefined
  }

  // Lower index = higher priority. Models not in the list sort after all listed ones.
  const SORT_PRIORITY = ["sonnet", "gpt-5-codex", "opus", "o3", "o4-mini", "haiku"]

  export function sort(models: Model[]): Model[] {
    return sortBy(
      models,
      [
        (model) => {
          const idx = SORT_PRIORITY.findIndex((filter) => model.id.includes(filter))
          return idx === -1 ? SORT_PRIORITY.length : idx
        },
        "asc",
      ],
      [(model) => model.id, "asc"],
    )
  }

  export async function defaultModel(): Promise<{ providerID: string; modelID: string }> {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const providers = await list()
    // Prefer claude-code / sonnet as the default
    const claudeCode = providers["claude-code"]
    if (claudeCode?.models["claude-sonnet-4-6"]) {
      return { providerID: "claude-code", modelID: "claude-sonnet-4-6" }
    }

    const entries = Object.values(providers)
    if (entries.length === 0) throw new Error("No CLI providers found. Install claude or codex.")
    const provider = entries[0]!
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("No models found")
    return { providerID: provider.id, modelID: model.id }
  }

  export function parseModel(model: string): { providerID: string; modelID: string } {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID ?? "",
      modelID: rest.join("/"),
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Error types
  // ─────────────────────────────────────────────────────────────────────────────

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )

  export const ConfiguredModelError = NamedError.create(
    "ProviderConfiguredModelError",
    z.object({
      path: z.string(),
      model: z.string(),
      message: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )
}
