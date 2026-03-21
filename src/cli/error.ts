import { Config } from "@/core/config/config"
import { Provider } from "@/provider/provider"
import { UI } from "./ui"

export function FormatError(input: unknown) {
  if (Provider.ModelNotFoundError.isInstance(input)) {
    const { providerID, modelID } = input.data
    return `Model not found: ${providerID}/${modelID}`
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
