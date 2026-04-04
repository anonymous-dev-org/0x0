import type { CompletionInput, CompletionProvider } from "./types"
import { Log } from "@/util/log"

const log = Log.create({ service: "completion:openai" })

const DEFAULT_MODEL = "gpt-4o-mini"
const API_URL = "https://api.openai.com/v1/chat/completions"

const SYSTEM_PROMPT = `You are a code completion engine. You receive code context with a <CURSOR> marker indicating where the user's cursor is. Output ONLY the code that should be inserted at the cursor position. No explanations, no markdown fences, no surrounding code — just the completion text. If you cannot determine a useful completion, output nothing.`

export class OpenAICompletionProvider implements CompletionProvider {
  readonly id = "openai"
  readonly name = "OpenAI"

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey()
  }

  async *complete(input: CompletionInput): AsyncGenerator<string> {
    const key = this.apiKey()
    if (!key) throw new Error("OPENAI_API_KEY not set")

    const model = input.model ?? DEFAULT_MODEL
    const maxTokens = input.maxTokens ?? 128
    const temperature = input.temperature ?? 0

    const userContent = buildPrompt(input)

    log.info("complete", { model, language: input.language })

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        stream: true,
        stop: input.stop,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal: input.abort,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    if (!response.body) throw new Error("No response body")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (data === "[DONE]") return

          try {
            const event = JSON.parse(data)
            const delta = event.choices?.[0]?.delta?.content
            if (delta) {
              yield delta
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private apiKey(): string | undefined {
    return process.env.OPENAI_API_KEY
  }
}

function buildPrompt(input: CompletionInput): string {
  const parts: string[] = []

  if (input.filepath) {
    parts.push(`File: ${input.filepath}`)
  }
  if (input.language) {
    parts.push(`Language: ${input.language}`)
  }
  parts.push("")
  parts.push(`${input.prefix}<CURSOR>${input.suffix}`)

  return parts.join("\n")
}
