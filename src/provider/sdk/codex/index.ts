import { Log } from "@/util/log"

const log = Log.create({ service: "codex" })

export type CompletionEvent = { type: "delta"; text: string } | { type: "error"; error: string } | { type: "done" }

export async function* completionStream(input: {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
  abort?: AbortSignal
}): AsyncGenerator<CompletionEvent> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    yield { type: "error", error: "OPENAI_API_KEY environment variable is not set" }
    return
  }

  log.info("starting codex completion stream", { model: input.model })

  const messages: Array<{ role: string; content: string }> = []
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt })
  }
  messages.push({ role: "user", content: input.prompt })

  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    stream: true,
  }
  if (input.stopSequences?.length) {
    body.stop = input.stopSequences
  }

  let response: Response
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: input.abort,
    })
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name === "AbortError") return
    yield { type: "error", error: `OpenAI API request failed: ${e?.message ?? err}` }
    return
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error")
    yield { type: "error", error: `OpenAI API error (${response.status}): ${errorBody}` }
    return
  }

  if (!response.body) {
    yield { type: "error", error: "No response body from OpenAI API" }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const newlinePos = buffer.indexOf("\n")
        if (newlinePos === -1) break

        const line = buffer.slice(0, newlinePos)
        buffer = buffer.slice(newlinePos + 1)

        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") {
          yield { type: "done" }
          return
        }
        if (!data) continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) {
            yield { type: "delta", text: delta.content }
          }
        } catch {
          log.warn("failed to parse SSE chunk", { data: data.slice(0, 200) })
        }
      }
    }

    yield { type: "done" }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      yield { type: "error", error: String(e?.message ?? err) }
    }
  } finally {
    reader.releaseLock()
  }
}
