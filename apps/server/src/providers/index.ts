import { AcpProvider } from "./acp"
import type { ChatProvider, ProviderRuntimeConfig } from "./types"
import type { ProviderId } from "@anonymous-dev/0x0-contracts"

export type ProviderRegistry = Record<ProviderId, ChatProvider>

export function createProviderRegistry(config: ProviderRuntimeConfig = {}): ProviderRegistry {
  return {
    codex: new AcpProvider({
      id: "codex",
      label: "Codex",
      command: config.codexCommand ?? "codex-acp",
      defaultModel: "gpt-5.4",
      models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
      authMethod: "chatgpt",
    }),
    claude: new AcpProvider({
      id: "claude",
      label: "Claude Code",
      command: config.claudeCommand ?? "claude-agent-acp",
      defaultModel: "sonnet",
      models: ["sonnet", "opus", "haiku"],
    }),
  }
}
