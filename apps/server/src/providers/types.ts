import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ProviderId,
  ProviderInfo,
} from "@anonymous-dev/0x0-contracts"
import type { LanguageModel } from "ai"

export type ProviderRuntimeConfig = {
  openAiApiKey?: string
  anthropicApiKey?: string
}

export interface ChatProvider {
  readonly id: ProviderId
  readonly info: ProviderInfo
  stream(input: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent>
  complete(input: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  aiModel?(model: string): LanguageModel
}
