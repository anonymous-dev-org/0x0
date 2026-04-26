import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ProviderId,
  ProviderInfo,
} from "@anonymous-dev/0x0-contracts"

export type ProviderRuntimeConfig = {
  codexCommand?: string
  claudeCommand?: string
}

export interface ChatProvider {
  readonly id: ProviderId
  readonly info: ProviderInfo
  stream(input: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent>
  complete(input: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  runSessionTurn?(input: {
    sessionId: string
    cwd: string
    prompt: string
    effort?: string
    signal?: AbortSignal
    onDelta?: (text: string) => void
    onStatus?: (status: string) => void
  }): Promise<string>
  cancelSession?(sessionId: string): Promise<void>
  close?(): void
}
