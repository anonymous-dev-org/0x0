import type {
  ChatRequest,
  CompletionRequest,
  InlineEditRequest,
  ProviderId,
} from "@anonymous-dev/0x0-contracts"
import type { ProviderRegistry } from "./providers"

const INLINE_EDIT_SYSTEM_PROMPT = [
  "You are an inline code editor.",
  "Return only the replacement text for the selected range.",
  "Do not include markdown fences, explanations, or surrounding unchanged text unless it belongs in the replacement.",
].join("\n")

export function getDefaultProviderId(registry: ProviderRegistry): ProviderId {
  return Object.values(registry).find((provider) => provider.info.configured)?.id ?? "codex"
}

function toCompletionPrompt(request: CompletionRequest) {
  return [
    `File: ${request.filepath}`,
    `Language: ${request.language}`,
    "",
    "Complete the code at the cursor. Return only the text that should be inserted.",
    "",
    "<prefix>",
    request.prefix,
    "</prefix>",
    "",
    "<suffix>",
    request.suffix,
    "</suffix>",
  ].join("\n")
}

export function toCompletionChatRequest(
  registry: ProviderRegistry,
  request: CompletionRequest,
): ChatRequest {
  const providerId = request.provider ?? getDefaultProviderId(registry)
  const provider = registry[providerId]

  return {
    provider: providerId,
    model: request.model ?? provider.info.defaultModel,
    stream: request.stream,
    systemPrompt:
      "You are an inline code completion engine. Produce concise code continuations without markdown fences or explanation.",
    messages: [
      {
        role: "user",
        content: toCompletionPrompt(request),
      },
    ],
  }
}

export function toInlineEditChatRequest(
  registry: ProviderRegistry,
  request: InlineEditRequest,
): ChatRequest {
  const providerId = request.provider ?? getDefaultProviderId(registry)
  const provider = registry[providerId]

  return {
    provider: providerId,
    model: request.model ?? provider.info.defaultModel,
    stream: false,
    systemPrompt: INLINE_EDIT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `File: ${request.file}`,
          `Range: ${request.range.startLine}:${request.range.startColumn}-${request.range.endLine}:${request.range.endColumn}`,
          "",
          request.prompt,
          "",
          "<selected_text>",
          request.text,
          "</selected_text>",
        ].join("\n"),
      },
    ],
  }
}
