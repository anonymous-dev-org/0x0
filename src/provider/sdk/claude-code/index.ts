import { Log } from "@/util/log"

const log = Log.create({ service: "claude-code" })

export type CompletionEvent = { type: "delta"; text: string } | { type: "error"; error: string } | { type: "done" }

function spawnEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

export async function* completionStream(input: {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
  abort?: AbortSignal
}): AsyncGenerator<CompletionEvent> {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--model", input.model,
    "--tools", "",
    "--max-turns", "1",
    "--no-session-persistence",
  ]

  if (input.systemPrompt) {
    args.push("--system-prompt", input.systemPrompt)
  }

  args.push(input.prompt)

  log.info("starting completion stream", { model: input.model })

  let proc: ReturnType<typeof Bun.spawn> | undefined

  try {
    proc = Bun.spawn(["claude", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv(),
    })

    if (input.abort) {
      const abortHandler = () => proc?.kill()
      input.abort.addEventListener("abort", abortHandler, { once: true })
    }

    const decoder = new TextDecoder()
    let buffer = ""
    let done = false
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (done) break
          const trimmed = line.trim()
          if (!trimmed) continue

          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(trimmed)
          } catch {
            continue
          }

          if (msg.type === "stream_event") {
            const event = msg.event as Record<string, unknown> | undefined
            if (
              event?.type === "content_block_delta" &&
              (event.delta as Record<string, unknown>)?.type === "text_delta" &&
              (event.delta as Record<string, unknown>)?.text
            ) {
              let text = (event.delta as Record<string, unknown>).text as string
              if (input.stopSequences?.length) {
                for (const stop of input.stopSequences) {
                  const idx = text.indexOf(stop)
                  if (idx !== -1) {
                    text = text.slice(0, idx)
                    if (text) yield { type: "delta", text }
                    yield { type: "done" }
                    done = true
                    break
                  }
                }
                if (done) break
              }
              if (text) yield { type: "delta", text }
            }
          } else if (msg.type === "result") {
            if (!done && msg.result && typeof msg.result === "string") {
              yield { type: "delta", text: msg.result }
            }
            if (!done) {
              yield { type: "done" }
              done = true
            }
          }
        }
      }

      // Process remaining buffer
      buffer += decoder.decode(undefined, { stream: false })
      if (!done && buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim())
          if (msg.type === "result" && msg.result && typeof msg.result === "string") {
            yield { type: "delta", text: msg.result }
          }
        } catch {}
        if (!done) yield { type: "done" }
        done = true
      }
    } finally {
      reader.releaseLock()
    }

    if (!done) yield { type: "done" }
    await proc.exited
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      yield { type: "error", error: String(e?.message ?? err) }
    }
  } finally {
    if (proc && !proc.killed) {
      try { proc.kill() } catch {}
    }
  }
}
