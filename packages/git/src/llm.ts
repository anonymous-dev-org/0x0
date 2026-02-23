import type { Config } from "./config"

/**
 * One-shot text generation via the 0x0 server's /completion/text endpoint.
 * Returns the generated text or throws on failure.
 */
export async function generate(config: Config, prompt: string): Promise<string> {
  const url = `${config.url.replace(/\/$/, "")}/completion/text`

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (config.auth) {
    const credentials = btoa(`${config.auth.username}:${config.auth.password}`)
    headers["Authorization"] = `Basic ${credentials}`
  }

  const body: Record<string, unknown> = { prompt }
  if (config.model) body.model = config.model

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error")
    throw new Error(`Server error (${response.status}): ${errorBody}`)
  }

  if (!response.body) {
    throw new Error("No response body from server")
  }

  // Read SSE stream and collect delta text
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const parts: string[] = []

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

      const jsonStr = line.slice(5).trim()
      if (!jsonStr) continue

      try {
        const parsed = JSON.parse(jsonStr)
        if (parsed.type === "delta" && parsed.text) {
          parts.push(parsed.text)
        } else if (parsed.type === "error") {
          throw new Error(parsed.error || "Server stream error")
        }
      } catch (err) {
        if (err instanceof Error && err.message !== "Server stream error") {
          // skip malformed JSON
          continue
        }
        throw err
      }
    }
  }

  const text = parts.join("").trim()
  if (!text) {
    throw new Error("No response text from server")
  }

  return text
}
