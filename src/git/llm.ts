import type { GitConfig } from "./config"

function createDebug(verbose: boolean) {
  return (msg: string) => {
    if (verbose) process.stderr.write(`[debug] ${msg}\n`)
  }
}

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(1_000) })
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

  const binary = Bun.which("0x0") || process.execPath
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

export async function generate(config: GitConfig, prompt: string): Promise<string> {
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

  const body: Record<string, unknown> = { prompt, provider: config.provider }
  if (config.model) body.model = config.model

  debug(`POST ${url} (auth=${config.auth ? "yes" : "no"})`)

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

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error")
    throw new Error(`Server error (${response.status}): ${errorBody}`)
  }

  if (!response.body) {
    throw new Error("No response body from server")
  }

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
        if (err instanceof SyntaxError) continue
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
