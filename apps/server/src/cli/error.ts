import { Config } from "@/core/config/config"
import { UI } from "./ui"
import { SessionNotFoundError, SessionBusyError, ProviderUnavailableError } from "@/server/error"

export function FormatError(input: unknown) {
  if (SessionNotFoundError.isInstance(input)) {
    return `Session not found: ${input.data.id}`
  }
  if (SessionBusyError.isInstance(input)) {
    return `Session is busy: ${input.data.id}`
  }
  if (ProviderUnavailableError.isInstance(input)) {
    return `Provider unavailable (${input.data.provider}): ${input.data.message}`
  }
  if (Config.JsonError.isInstance(input)) {
    return (
      `Config file at ${input.data.path} is not valid JSON` +
      (input.data.message ? `: ${input.data.message}` : "")
    )
  }
  if (Config.InvalidError.isInstance(input))
    return [
      `Configuration is invalid${input.data.path && input.data.path !== "config" ? ` at ${input.data.path}` : ""}` +
        (input.data.message ? `: ${input.data.message}` : ""),
      ...(input.data.issues?.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")) ?? []),
    ].join("\n")

  if (UI.CancelledError.isInstance(input)) return ""
}
