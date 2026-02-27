import type { McpServer } from "@agentclientprotocol/sdk"
import type { Client } from "@/server/client"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
  modeId?: string
  modes?: Record<
    string,
    {
      model?: {
        providerID: string
        modelID: string
      }
      variant?: string
    }
  >
}

export interface ACPConfig {
  sdk: Client
  baseUrl?: string
  defaultModel?: {
    providerID: string
    modelID: string
  }
}
