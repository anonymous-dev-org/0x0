import z from "zod"
import { NamedError } from "@/util/error"

export const SessionNotFoundError = NamedError.create(
  "SessionNotFoundError",
  z.object({ id: z.string() }),
)

export const SessionBusyError = NamedError.create(
  "SessionBusyError",
  z.object({ id: z.string() }),
)

export const ProviderUnavailableError = NamedError.create(
  "ProviderUnavailableError",
  z.object({ provider: z.string(), message: z.string() }),
)

export const UnsupportedProviderOptionsError = NamedError.create(
  "UnsupportedProviderOptionsError",
  z.object({
    provider: z.string(),
    options: z.array(z.string()),
    supported_options: z.array(z.string()),
  }),
)
