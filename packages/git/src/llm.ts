import type { Config } from "./config"

function createDebug(verbose: boolean) {
  return (msg: string) => {
    if (verbose) process.stderr.write(`[debug] ${msg}\n`)
  }
}

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl.replace(/\/$/, ""), { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

async function ensureServer(baseUrl: string, debug: (msg: string) => void): Promise<void> {
  if (await isServerUp(baseUrl)) {
    debug(`server already running at ${baseUrl}`)
    return
  }

  const binary = Bun.which("0x0")
  if (!binary) throw new Error("0x0 not found in PATH. Cannot auto-start server.")

  const port = new URL(baseUrl).port || "4096"
  debug(`spawning server: ${binary} server --port ${port}`)
  process.stderr.write("Starting 0x0 server...\n")

  const proc = Bun.spawn([binary, "server", "--port", port], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  proc.unref()

  const deadline = Date.now() + 15_000
  let dots = 0
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 300))
    if (await isServerUp(baseUrl)) {
      if (dots > 0) process.stderr.write("\n")
      return
    }
    process.stderr.write(".")
    dots++
  }

  if (dots > 0) process.stderr.write("\n")
  throw new Error("0x0 server did not start within 15 seconds.")
}

/**
 * One-shot text generation via the 0x0 server's /completion/text endpoint.
 * Returns the generated text or throws on failure.
 */
export async function generate(config: Config, prompt: string): Promise<string> {
  const debug = createDebug(config.verbose)

  debug(`config: url=${config.url} provider=${config.provider} model=${config.model} auth=${config.auth ? "yes" : "no"}`)

  await ensureServer(config.url, debug)

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

  debug(`POST ${url} (auth=${config.auth ? "yes" : "no"})`)
  debug(`request body: ${JSON.stringify(body)}`)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    throw new Error(`Failed to connect to 0x0 server at ${config.url}`, { cause: err })
  }

  debug(`response: ${response.status} ${response.statusText}`)
  debug(`response headers: content-type=${response.headers.get("content-type")}`)

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error")
    debug(`error response body: ${errorBody}`)
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
          debug(`stream: delta chunk=${parsed.text.length}b total=${parts.length}`)
        } else if (parsed.type === "error") {
          debug(`stream: error — ${parsed.error}`)
          throw new Error(parsed.error || "Server stream error")
        } else if (parsed.type === "done") {
          debug(`stream: done`)
        } else {
          debug(`stream: unexpected event type=${parsed.type} data=${jsonStr.slice(0, 200)}`)
        }
      } catch (err) {
        // Re-throw errors from parsed server error events
        if (err instanceof SyntaxError) {
          debug(`stream: malformed JSON chunk: ${jsonStr.slice(0, 200)}`)
          continue
        }
        throw err
      }
    }
  }

  const text = parts.join("").trim()
  debug(`result: ${parts.length} deltas, ${text.length} chars`)

  if (!text) {
    throw new Error("No response text from server")
  }

  return text
}
