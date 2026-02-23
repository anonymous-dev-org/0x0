export type AssistantHeaderMessage = {
  role: "assistant"
  agent: string
  modelID?: string
}

export type SessionHeaderMessage =
  | AssistantHeaderMessage
  | {
      role: "user"
    }

export function shouldShowAssistantHeader(
  previous: SessionHeaderMessage | undefined,
  current: AssistantHeaderMessage,
): boolean {
  if (!previous || previous.role !== "assistant") return true
  const previousModel = previous.modelID?.trim() ?? ""
  const currentModel = current.modelID?.trim() ?? ""
  return previous.agent !== current.agent || previousModel !== currentModel
}
