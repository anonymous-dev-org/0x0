import type { ChatMessage, ProviderId } from "@anonymous-dev/0x0-contracts"

export type AgentToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type AgentToolCall = {
  id: string
  name: string
  input: unknown
}

export type AgentToolResult = {
  callId: string
  output: string
}

export type AgentStepResult = {
  text: string
  toolCalls: AgentToolCall[]
}

export type AgentMessage = ChatMessage | {
  role: "tool"
  toolCallId: string
  content: string
}

export type AgentStepInput = {
  provider: ProviderId
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: AgentToolDefinition[]
}
