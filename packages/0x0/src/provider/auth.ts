import z from "zod"
import { fn } from "@/util/fn"
import { NamedError } from "@0x0-ai/util/error"

export namespace ProviderAuth {
  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods(): Promise<Record<string, Method[]>> {
    // CLI providers manage their own auth — no methods to show
    return {}
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  /** Check whether the CLI binary for the given provider is on PATH.
   *  @param envPath  Override the PATH used for lookup (useful in tests).
   */
  export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
    const opts = envPath !== undefined ? { PATH: envPath } : undefined
    if (providerID === "claude-code") {
      return Promise.resolve(Bun.which("claude", opts) !== null)
    }
    if (providerID === "codex") {
      return Promise.resolve(Bun.which("codex", opts) !== null)
    }
    return Promise.resolve(false)
  }

  export const authorize = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
    }),
    async (_input): Promise<Authorization | undefined> => {
      // CLI providers manage their own auth — no OAuth flow
      return undefined
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
    }),
    async (_input) => {
      // No-op for CLI providers
    },
  )

  export const api = fn(
    z.object({
      providerID: z.string(),
      key: z.string(),
    }),
    async (_input) => {
      // No-op for CLI providers
    },
  )

  export const OauthMissing = NamedError.create(
    "ProviderAuthOauthMissing",
    z.object({
      providerID: z.string(),
    }),
  )
  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({
      providerID: z.string(),
    }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))
}
