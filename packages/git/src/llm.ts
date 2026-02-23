import type { Provider } from "./config"

/**
 * One-shot text generation via CLI subprocess.
 * Returns the generated text or throws on failure.
 */
export async function generate(
  provider: Provider,
  model: string,
  prompt: string,
): Promise<string> {
  if (provider === "claude") {
    return generateClaude(model, prompt)
  }
  return generateCodex(model, prompt)
}

async function generateClaude(
  model: string,
  prompt: string,
): Promise<string> {
  const binary = Bun.which("claude")
  if (!binary) throw new Error("claude binary not found in PATH")

  const proc = Bun.spawn(
    [binary, "--output-format", "text", "--model", model, "-p", prompt],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  )

  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
  }

  return text.trim()
}

async function generateCodex(
  model: string,
  prompt: string,
): Promise<string> {
  const binary = Bun.which("codex")
  if (!binary) throw new Error("codex binary not found in PATH")

  const proc = Bun.spawn(
    [binary, "exec", "--experimental-json", "--model", model],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...process.env },
    },
  )

  proc.stdin.write(prompt)
  proc.stdin.end()

  const raw = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`codex exited with code ${exitCode}: ${stderr}`)
  }

  // Parse JSON lines, extract agent_message text
  const parts: string[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line.trim())
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text
      ) {
        parts.push(event.item.text)
      }
    } catch {
      // skip non-JSON lines
    }
  }

  if (parts.length === 0) {
    throw new Error("No response text from codex")
  }

  return parts.join("").trim()
}
