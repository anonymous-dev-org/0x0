import { createOpenAI } from "@ai-sdk/openai"
import { generateText, streamText } from "ai"
import type { ChatProvider } from "./types"
import type { ChatRequest, ChatResponse, ChatStreamEvent } from "@anonymous-dev/0x0-contracts"

const MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] as const

export function createCodexProvider(apiKey?: string): ChatProvider {
  const ai = apiKey ? createOpenAI({ apiKey }) : undefined

  return {
    id: "codex",
    info: {
      id: "codex",
      label: "Codex",
      defaultModel: MODELS[0],
      models: [...MODELS],
      configured: Boolean(apiKey),
    },
    async *stream(input, signal) {
      if (!ai) {
        throw new Error("OPENAI_API_KEY is not configured.")
      }

      let text = ""
      let usage: ChatResponse["usage"]

      yield {
        type: "start",
        provider: "codex",
        model: input.model,
      } satisfies ChatStreamEvent

      const result = streamText({
        model: ai(input.model),
        system: input.systemPrompt,
        messages: input.messages,
        abortSignal: signal,
      })

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.text
          yield {
            type: "text_delta",
            text: part.text,
          } satisfies ChatStreamEvent
        }
        if (part.type === "finish") {
          usage = {
            inputTokens: part.totalUsage.inputTokens,
            outputTokens: part.totalUsage.outputTokens,
          }
        }
        if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        }
      }

      yield {
        type: "done",
        provider: "codex",
        model: input.model,
        text,
        usage,
      } satisfies ChatStreamEvent
    },
    async complete(input, signal) {
      if (!ai) {
        throw new Error("OPENAI_API_KEY is not configured.")
      }
      const response = await generateText({
        model: ai(input.model),
        system: input.systemPrompt,
        messages: input.messages,
        abortSignal: signal,
      })

      return {
        provider: "codex",
        model: input.model,
        text: response.text,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      }
    },
    aiModel(model) {
      if (!ai) {
        throw new Error("OPENAI_API_KEY is not configured.")
      }
      return ai(model)
    },
  }
}
