import { Log } from "@/util/log"
import {
  CommonMessageOptionKeys,
  createProviderInputSchema,
  type AgentProvider,
  type SpawnInput,
  type StreamEvent,
} from "./types"

const log = Log.create({ service: "codex" })

export const CodexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",
  supportedMessageOptions: [
    ...CommonMessageOptionKeys,
    "sandbox",
    "model_reasoning_effort",
  ],
  inputSchema: createProviderInputSchema({
    sandbox: {
      type: "string",
      description: "Codex sandbox mode.",
    },
    model_reasoning_effort: {
      type: "string",
      description: "Codex reasoning effort.",
      enum: ["minimal", "low", "medium", "high", "xhigh"],
    },
  }),

  async isAvailable() {
    return Bun.which("codex") !== null
  },

  async *spawn(input: SpawnInput): AsyncGenerator<StreamEvent> {
    const args = ["exec"]

    if (input.sessionId) {
      args.push("resume", "--last")
    }

    args.push("--json")

    if (input.model) args.push("-m", input.model)
    if (input.sandbox) args.push("-s", input.sandbox)
    if (input.modelReasoningEffort) {
      args.push("-c", `model_reasoning_effort="${input.modelReasoningEffort}"`)
    }
    if (input.cwd) args.push("-C", input.cwd)

    args.push(input.prompt)

    log.info("spawning", { args: args.filter((_, i) => i < 6) })

    let proc: ReturnType<typeof Bun.spawn> | undefined

    try {
      proc = Bun.spawn(["codex", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })

      if (input.abort) {
        input.abort.addEventListener("abort", () => proc?.kill(), { once: true })
      }

      const decoder = new TextDecoder()
      let buffer = ""
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            let msg: Record<string, unknown>
            try {
              msg = JSON.parse(trimmed)
            } catch {
              continue
            }

            yield* normalizeCodexEvent(msg)
          }
        }

        buffer += decoder.decode(undefined, { stream: false })
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim())
            yield* normalizeCodexEvent(msg)
          } catch {}
        }
      } finally {
        reader.releaseLock()
      }

      await proc.exited
      yield { type: "done" }
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
  },
}

export function* normalizeCodexEvent(msg: Record<string, unknown>): Generator<StreamEvent> {
  const type = msg.type as string | undefined

  switch (type) {
    case "thread.started": {
      const threadId = typeof msg.thread_id === "string" ? msg.thread_id : undefined
      yield { type: "init", session_id: threadId }
      break
    }

    case "turn.completed": {
      const usage = asRecord(msg.usage)
      let inputTokens: number | undefined
      if (usage) {
        const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
        const cached = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0
        inputTokens = input + cached
      }
      yield {
        type: "result",
        input_tokens: inputTokens,
      }
      break
    }

    case "item.started": {
      const item = asRecord(msg.item)
      if (item?.type === "command_execution") {
        yield {
          type: "tool_use",
          name: "command_execution",
          id: typeof item.id === "string" ? item.id : undefined,
          input: {
            command: item.command,
          },
        }
      } else {
        yield { type: "raw", data: msg }
      }
      break
    }

    case "item.completed": {
      const item = asRecord(msg.item)
      if (item?.type === "agent_message") {
        const text = typeof item.text === "string" ? item.text : undefined
        if (text) {
          yield { type: "text_delta", text }
        }
      } else if (item?.type === "command_execution") {
        yield {
          type: "tool_result",
          tool_use_id: typeof item.id === "string" ? item.id : undefined,
          content: {
            command: item.command,
            aggregated_output: item.aggregated_output,
            exit_code: item.exit_code,
            status: item.status,
          },
        }
      } else {
        yield { type: "raw", data: msg }
      }
      break
    }

    case "message": {
      const role = msg.role as string | undefined
      const content = msg.content as string | undefined
      if (role === "assistant" && content) {
        yield { type: "text_delta", text: content }
      }
      break
    }

    case "function_call": {
      yield {
        type: "tool_use",
        name: msg.name as string ?? "unknown",
        id: msg.call_id as string | undefined,
        input: msg.arguments,
      }
      break
    }

    case "function_call_output": {
      yield {
        type: "tool_result",
        tool_use_id: msg.call_id as string | undefined,
        content: msg.output,
      }
      break
    }

    case "error": {
      yield {
        type: "error",
        error: typeof msg.message === "string" ? msg.message : "Codex stream error",
      }
      break
    }

    default:
      yield { type: "raw", data: msg }
      break
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}
