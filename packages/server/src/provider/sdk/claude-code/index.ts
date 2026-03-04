import { Log } from "@/util/log"
import { Server } from "@/server/server"
import { registerBridge, unregisterBridge, type BridgeContext } from "@/server/routes/tool-bridge"
import { ToolRegistry } from "@/tool/registry"
import type { Agent } from "@/runtime/agent/agent"

const log = Log.create({ service: "claude-code" })

// MCP tool prefix used by Claude CLI for our MCP server named "tools"
const MCP_PREFIX = "mcp__tools__"

function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type ClaudeEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "message-boundary" }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-input-delta"; id: string; partial: string }
  | { type: "tool-end"; id: string }
  | { type: "step-start" }
  | { type: "step-end" }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string }

export type ClaudeStreamInput = {
  modelId: string
  prompt: string
  systemPrompt?: string
  cliSessionId?: string
  abort: AbortSignal
  thinkingEffort?: string
  sessionID: string
  agentName: string
  agent: Agent.Info
  cwd?: string
}

// ─── Bridge management ───────────────────────────────────────────────────────

async function createBridge(input: ClaudeStreamInput): Promise<{ bridgeId: string; cleanup: () => void }> {
  const bridgeId = crypto.randomUUID()

  const rawTools = await ToolRegistry.tools(
    { providerID: "claude-code", modelID: input.modelId },
    input.agent,
  )
  const tools: BridgeContext["tools"] = rawTools.map((t) => ({
    id: t.id,
    description: t.description,
    parameters: t.parameters,
    execute: (args: any, ctx: any) => t.execute(args, ctx),
  }))

  registerBridge(bridgeId, {
    sessionID: input.sessionID,
    agentName: input.agentName,
    agent: input.agent,
    abort: input.abort,
    tools,
  })

  return {
    bridgeId,
    cleanup: () => unregisterBridge(bridgeId),
  }
}

// ─── CLI spawning ────────────────────────────────────────────────────────────

function spawnEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  // Prevent Claude CLI's nested-session detection
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

function buildCliArgs(input: ClaudeStreamInput, bridgeId: string): string[] {
  const serverUrl = Server.url()
  const dir = input.cwd ?? process.cwd()
  const mcpUrl = `${serverUrl.origin}/tool-bridge/${bridgeId}?directory=${encodeURIComponent(dir)}`

  const mcpConfig = JSON.stringify({
    mcpServers: {
      tools: {
        type: "http",
        url: mcpUrl,
        timeout: 600, // 10 minutes — question tool needs long-lived connections
      },
    },
  })

  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--model", input.modelId,
    "--tools", "",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--allowedTools", "mcp__tools__*",
  ]

  if (input.systemPrompt) {
    args.push("--system-prompt", input.systemPrompt)
  }

  if (input.thinkingEffort) {
    args.push("--effort", input.thinkingEffort)
  }

  if (input.cliSessionId) {
    args.push("--resume", input.cliSessionId)
  }

  // Prompt goes last
  args.push(input.prompt)

  return args
}

// ─── NDJSON stream parser ────────────────────────────────────────────────────

/**
 * Parse NDJSON lines from the `claude` CLI's `--output-format stream-json`
 * into our internal ClaudeEvent stream.
 *
 * Key event shapes from the CLI:
 * - { type: "system", subtype: "init", session_id, ... }
 * - { type: "stream_event", event: BetaRawMessageStreamEvent, ... }
 * - { type: "assistant", message: BetaMessage, session_id, ... }
 * - { type: "result", subtype: "success"|"error_*", session_id, ... }
 */
async function* parseNdjson(
  stdout: ReadableStream<Uint8Array>,
  abort: AbortSignal,
): AsyncGenerator<ClaudeEvent> {
  const decoder = new TextDecoder()
  let sessionId = ""
  let buffer = ""
  let emittedStepStart = false
  let emittedAnyText = false
  // Track active content block types by index
  const blockTypes: Record<number, string> = {}
  const blockIds: Record<number, string> = {}

  function* handleLine(trimmed: string): Generator<ClaudeEvent> {
    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      log.warn("failed to parse NDJSON line", { line: trimmed.slice(0, 200) })
      return
    }

    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id ?? ""
      return
    }

    if (msg.type === "stream_event") {
      const event = msg.event
      if (!event) return

      switch (event.type) {
        case "message_start": {
          // Only emit step-start once per claudeStream call
          if (!emittedStepStart) {
            yield { type: "step-start" }
            emittedStepStart = true
          }
          yield { type: "message-boundary" }
          break
        }

        case "content_block_start": {
          const idx = event.index ?? 0
          const block = event.content_block
          if (!block) break

          if (block.type === "tool_use") {
            blockTypes[idx] = "tool_use"
            blockIds[idx] = block.id ?? `tool-${idx}`
            // Strip MCP prefix so processor sees clean tool names (Bash, Read, etc.)
            const cleanName = stripMcpPrefix(block.name ?? "")
            yield { type: "tool-start", id: block.id ?? `tool-${idx}`, name: cleanName }
          } else if (block.type === "thinking") {
            blockTypes[idx] = "thinking"
            blockIds[idx] = `thinking-${idx}`
          } else if (block.type === "text") {
            blockTypes[idx] = "text"
          }
          break
        }

        case "content_block_delta": {
          const idx = event.index ?? 0
          const delta = event.delta
          if (!delta) break

          if (delta.type === "text_delta" && delta.text) {
            emittedAnyText = true
            yield { type: "text-delta", text: delta.text }
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { type: "reasoning-delta", id: blockIds[idx] ?? "thinking", text: delta.thinking }
          } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
            const id = blockIds[idx]
            if (id) {
              yield { type: "tool-input-delta", id, partial: delta.partial_json }
            }
          }
          break
        }

        case "content_block_stop": {
          const idx = event.index ?? 0
          const blockType = blockTypes[idx]
          if (blockType === "tool_use") {
            const id = blockIds[idx]
            if (id) {
              yield { type: "tool-end", id }
            }
          }
          delete blockTypes[idx]
          delete blockIds[idx]
          break
        }

        case "message_stop": {
          yield { type: "message-boundary" }
          break
        }
      }
      return
    }

    if (msg.type === "assistant") {
      if (msg.session_id) sessionId = msg.session_id

      // Fallback: if stream_event didn't produce text deltas, extract from
      // the full assistant message so the TUI still shows something.
      if (!emittedAnyText && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            yield { type: "text-delta", text: block.text }
            emittedAnyText = true
          }
        }
      }
      return
    }

    if (msg.type === "result") {
      if (msg.session_id) sessionId = msg.session_id

      // Fallback: extract text from result if we still have nothing
      if (!emittedAnyText && msg.result && typeof msg.result === "string") {
        yield { type: "text-delta", text: msg.result }
      }

      yield { type: "step-end" }

      if (msg.subtype === "success") {
        yield { type: "done", sessionId }
      } else {
        const errors = msg.errors?.join("; ") ?? msg.subtype ?? "unknown error"
        yield { type: "error", message: errors }
        yield { type: "done", sessionId }
      }
      return
    }
  }

  const reader = stdout.getReader()
  try {
    while (true) {
      if (abort.aborted) break
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        yield* handleLine(trimmed)
      }
    }

    // Flush decoder and process any remaining data in the buffer
    buffer += decoder.decode(undefined, { stream: false })
    if (buffer.trim()) {
      yield* handleLine(buffer.trim())
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Main stream function ─────────────────────────────────────────────────────

export async function* claudeStream(input: ClaudeStreamInput): AsyncGenerator<ClaudeEvent> {
  let bridge: { bridgeId: string; cleanup: () => void } | undefined

  try {
    bridge = await createBridge(input)
  } catch (err) {
    yield { type: "error", message: `Failed to create tool bridge: ${err instanceof Error ? err.message : String(err)}` }
    return
  }

  const args = buildCliArgs(input, bridge.bridgeId)
  log.info("spawning claude CLI", {
    model: input.modelId,
    sessionID: input.sessionID,
    agent: input.agentName,
    bridgeId: bridge.bridgeId,
    cliSessionId: input.cliSessionId,
  })

  let proc: ReturnType<typeof Bun.spawn> | undefined

  try {
    proc = Bun.spawn(["claude", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: input.cwd ?? process.cwd(),
      env: spawnEnv(),
    })

    // Handle abort
    const abortHandler = () => {
      proc?.kill()
    }
    input.abort.addEventListener("abort", abortHandler, { once: true })

    // Consume stderr in background for debugging
    const stderrChunks: string[] = []
    ;(async () => {
      if (!proc?.stderr) return
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = dec.decode(value, { stream: true })
          stderrChunks.push(text)
          if (text.trim()) log.info("claude stderr", { text: text.trim().slice(0, 500) })
        }
      } catch {
        // stderr closed
      } finally {
        reader.releaseLock()
      }
    })()

    yield* parseNdjson(proc.stdout as ReadableStream<Uint8Array>, input.abort)

    // Wait for process to exit
    const exitCode = await proc.exited
    if (exitCode !== 0 && !input.abort.aborted) {
      const stderr = stderrChunks.join("")
      log.error("claude CLI exited with error", { exitCode, stderr: stderr.slice(0, 1000) })
      yield { type: "error", message: `claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}` }
    }

    input.abort.removeEventListener("abort", abortHandler)
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError" && !input.abort.aborted) {
      yield { type: "error", message: String(e?.message ?? err) }
    }
  } finally {
    bridge.cleanup()
    if (proc && !proc.killed) {
      try { proc.kill() } catch {}
    }
  }
}

// ─── Completion stream (non-agentic, single turn) ─────────────────────────────

export type CompletionEvent = { type: "delta"; text: string } | { type: "error"; error: string } | { type: "done" }

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

          let msg: any
          try {
            msg = JSON.parse(trimmed)
          } catch {
            continue
          }

          if (msg.type === "stream_event") {
            const event = msg.event
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              let text = event.delta.text
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
            // Fallback: extract text from result
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
