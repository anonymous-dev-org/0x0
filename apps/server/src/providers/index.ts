import { createClaudeProvider } from "./claude"
import { createCodexProvider } from "./codex"
import type { ChatProvider, ProviderRuntimeConfig } from "./types"
import type { ProviderId } from "@anonymous-dev/0x0-contracts"

export type ProviderRegistry = Record<ProviderId, ChatProvider>

export function createProviderRegistry(config: ProviderRuntimeConfig = {}): ProviderRegistry {
  return {
    codex: createCodexProvider(config.openAiApiKey),
    claude: createClaudeProvider(config.anthropicApiKey),
  }
}
