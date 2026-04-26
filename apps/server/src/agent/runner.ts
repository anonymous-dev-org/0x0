import { CODE_TOOL_DEFINITIONS, runCodeTool } from "./tools"
import { runAiSdkAgentTurn } from "./ai-tools"
import type { ChatMessage } from "@anonymous-dev/0x0-contracts"
import type { ChatProvider } from "../providers/types"

type AgentRunnerInput = {
  provider: ChatProvider
  model: string
  prompt: string
  systemPrompt: string
  repoRoot: string
  worktreePath: string
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

type ParsedToolCall = {
  id?: string
  name: string
  input: unknown
}

const MAX_AGENT_STEPS = 10

function toolContractPrompt() {
  return [
    "Available tools are JSON-callable only. When you need a tool, respond with a single JSON object and no markdown:",
    '{"tool_calls":[{"id":"call-1","name":"read_file","input":{"path":"src/index.ts"}}]}',
    "",
    "When no more tools are needed, respond with normal assistant text.",
    "Tool definitions:",
    JSON.stringify(CODE_TOOL_DEFINITIONS, null, 2),
  ].join("\n")
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    return undefined
  }
  return candidate.slice(start, end + 1)
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const json = extractJsonObject(text)
  if (!json) {
    return []
  }

  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tool_calls?: unknown }).tool_calls)) {
      return []
    }
    return (parsed as { tool_calls: unknown[] }).tool_calls.flatMap((call) => {
      if (!call || typeof call !== "object") {
        return []
      }
      const record = call as Record<string, unknown>
      if (typeof record.name !== "string") {
        return []
      }
      return [{
        id: typeof record.id === "string" ? record.id : undefined,
        name: record.name,
        input: record.input ?? {},
      }]
    })
  } catch {
    return []
  }
}

function toolResultMessage(results: Array<{ call: ParsedToolCall; ok: boolean; output: string }>) {
  return [
    "Tool results:",
    JSON.stringify(
      results.map((result, index) => ({
        id: result.call.id ?? `call-${index + 1}`,
        name: result.call.name,
        ok: result.ok,
        output: result.output,
      })),
      null,
      2,
    ),
    "",
    "Continue. If more tools are needed, emit the next JSON tool_calls object. Otherwise summarize the completed work.",
  ].join("\n")
}

export async function runAgentTurn(input: AgentRunnerInput) {
  if (input.provider.aiModel) {
    return runAiSdkAgentTurn({
      model: input.provider.aiModel(input.model),
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      signal: input.signal,
      onDelta: input.onDelta,
    })
  }

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [toolContractPrompt(), "", "User request:", input.prompt].join("\n"),
    },
  ]
  let finalText = ""

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (input.signal?.aborted) {
      throw new Error("Operation cancelled.")
    }
    const response = await input.provider.complete(
      {
        provider: input.provider.id,
        model: input.model,
        stream: false,
        systemPrompt: input.systemPrompt,
        messages,
      },
      input.signal,
    )
    const toolCalls = parseToolCalls(response.text)

    if (!toolCalls.length) {
      finalText = response.text
      if (finalText) {
        input.onDelta?.(finalText)
      }
      break
    }

    messages.push({ role: "assistant", content: response.text })
    const results = []
    for (const call of toolCalls) {
      if (input.signal?.aborted) {
        throw new Error("Operation cancelled.")
      }
      const result = await runCodeTool(
        {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
        },
        call.name,
        call.input,
        input.signal,
      )
      results.push({ call, ...result })
    }
    messages.push({ role: "user", content: toolResultMessage(results) })
  }

  if (!finalText) {
    finalText = "Stopped after reaching the maximum agent tool-loop steps."
    input.onDelta?.(finalText)
  }

  return finalText
}
