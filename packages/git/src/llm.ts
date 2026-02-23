import type { Config } from "./config"

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl.replace(/\/$/, ""), { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

async function ensureServer(baseUrl: string): Promise<void> {
  if (await isServerUp(baseUrl)) return

  const binary = Bun.which("0x0")
  if (!binary) throw new Error("0x0 not found in PATH. Cannot auto-start server.")

  const port = new URL(baseUrl).port || "4096"
  process.stderr.write("Starting 0x0 server...\n")

  const proc = Bun.spawn([binary, "server", "--port", port], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  proc.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 300))
    if (await isServerUp(baseUrl)) return
  }

  throw new Error("0x0 server did not start within 15 seconds.")
}

/**
 * One-shot text generation via the 0x0 server's /completion/text endpoint.
 * Returns the generated text or throws on failure.
 */
export async function generate(config: Config, prompt: string): Promise<string> {
  await ensureServer(config.url)

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
