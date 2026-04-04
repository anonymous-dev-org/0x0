import { Log } from "@/util/log"
import {
  CommonMessageOptionKeys,
  createProviderInputSchema,
  type AgentProvider,
  type SpawnInput,
  type StreamEvent,
} from "./types"

const log = Log.create({ service: "claude" })

type ClaudeMessage = Record<string, unknown>

interface PendingClaudeToolUse {
  index: number
  name: string
  id?: string
  partialJson: string
  input?: unknown
}

export interface ClaudeStreamState {
  toolUses: Map<number, PendingClaudeToolUse>
}

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    toolUses: new Map(),
  }
}

function spawnEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

export const ClaudeProvider: AgentProvider = {
  id: "claude",
  name: "Claude",
  supportedMessageOptions: [
    ...CommonMessageOptionKeys,
    "effort",
    "system_prompt",
    "append_system_prompt",
    "allowed_tools",
    "disallowed_tools",
    "permission_mode",
    "max_turns",
  ],
  inputSchema: createProviderInputSchema({
    effort: {
      type: "string",
      description: "Claude effort level.",
      enum: ["low", "medium", "high", "max"],
    },
    system_prompt: {
      type: "string",
      description: "Provider system prompt override.",
    },
    append_system_prompt: {
      type: "string",
      description: "Extra system prompt text appended after the base prompt.",
    },
    allowed_tools: {
      type: "array",
      description: "Restrict Claude to this allowlist of tools.",
      items: { type: "string" },
    },
    disallowed_tools: {
      type: "array",
      description: "Block specific Claude tools.",
      items: { type: "string" },
    },
    permission_mode: {
      type: "string",
      description: "Claude permission mode.",
    },
    max_turns: {
      type: "integer",
      description: "Maximum Claude turns for this request.",
    },
  }),

  async isAvailable() {
    return Bun.which("claude") !== null
  },

  async *spawn(input: SpawnInput): AsyncGenerator<StreamEvent> {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
    ]

    if (input.sessionId) {
      args.push("--resume", input.sessionId)
    }
    // Note: we no longer pass --no-session-persistence so sessions can be resumed

    if (input.model) args.push("--model", input.model)
    if (input.effort) args.push("--effort", input.effort)
    if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt)
    if (input.appendSystemPrompt) args.push("--append-system-prompt", input.appendSystemPrompt)
    if (input.permissionMode) args.push("--permission-mode", input.permissionMode)
    if (input.maxTurns) args.push("--max-turns", String(input.maxTurns))

    // Prompt must come before any variadic flags (--allowed-tools, --disallowed-tools, --mcp-config)
    args.push(input.prompt)

    if (input.allowedTools?.length) args.push("--allowed-tools", ...input.allowedTools)
    if (input.disallowedTools?.length) args.push("--disallowed-tools", ...input.disallowedTools)
    if (input.mcpConfig) args.push("--mcp-config", input.mcpConfig)

    log.info("spawning", { args: args.filter((_, i) => i < 6) })

    let proc: ReturnType<typeof Bun.spawn> | undefined

    try {
      proc = Bun.spawn(["claude", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: input.cwd,
        env: spawnEnv(),
      })

      if (input.abort) {
        input.abort.addEventListener("abort", () => proc?.kill(), { once: true })
      }

      const decoder = new TextDecoder()
      let buffer = ""
      const state = createClaudeStreamState()
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

            yield* normalizeClaudeEvent(msg, state)
          }
        }

        // Process remaining buffer
        buffer += decoder.decode(undefined, { stream: false })
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim())
            yield* normalizeClaudeEvent(msg, state)
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

export function* normalizeClaudeEvent(
  msg: ClaudeMessage,
  state: ClaudeStreamState = createClaudeStreamState(),
): Generator<StreamEvent> {
  switch (msg.type) {
    case "system": {
      const subtype = typeof msg.subtype === "string" ? msg.subtype : undefined
      if (subtype === "init") {
        const sessionId = (msg as Record<string, unknown>).session_id as string | undefined
        yield { type: "init", session_id: sessionId }
        break
      }

      if (subtype) {
        yield {
          type: "agent_event",
          name: subtype,
          data: msg,
        }
        break
      }

      yield { type: "raw", data: msg }
      break
    }

    case "stream_event": {
      const event = msg.event as Record<string, unknown> | undefined
      if (!event) break

      switch (event.type) {
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: delta.text as string }
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            yield {
              type: "agent_event",
              name: "thinking",
              data: { text: delta.thinking as string },
            }
          } else if (delta?.type === "input_json_delta") {
            const index = typeof event.index === "number" ? event.index : undefined
            const partialJson =
              typeof delta.partial_json === "string" ? delta.partial_json : ""
            if (index !== undefined) {
              const pending = state.toolUses.get(index)
              if (pending) {
                pending.partialJson += partialJson
              }
            }
          }
          break
        }
        case "content_block_start": {
          const block = event.content_block as Record<string, unknown> | undefined
          if (block?.type === "tool_use") {
            const index = typeof event.index === "number" ? event.index : undefined
            if (index !== undefined) {
              state.toolUses.set(index, {
                index,
                name: String(block.name ?? "unknown"),
                id: typeof block.id === "string" ? block.id : undefined,
                partialJson: "",
                input: block.input,
              })
            }
          }
          break
        }
        case "content_block_stop": {
          const index = typeof event.index === "number" ? event.index : undefined
          if (index !== undefined) {
            const pending = state.toolUses.get(index)
            if (pending) {
              state.toolUses.delete(index)
              yield finalizeClaudeToolUse(pending)
            }
          }
          break
        }
        default:
          yield { type: "raw", data: event }
          break
      }
      break
    }

    case "assistant": {
      const parentToolUseId =
        typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : undefined
      const message = asRecord(msg.message)
      const content = Array.isArray(message?.content) ? message.content : []
      let yielded = false

      // Subagent inner tool calls are emitted in assistant messages
      // (with parent_tool_use_id set), not stream_event content blocks.
      if (parentToolUseId) {
        for (const item of content) {
          const record = asRecord(item)
          if (record?.type !== "tool_use") continue
          yielded = true
          yield {
            type: "tool_use",
            name: typeof record.name === "string" ? record.name : "unknown",
            id: typeof record.id === "string" ? record.id : undefined,
            input: record.input,
          }
        }
      }

      if (!yielded) {
        yield { type: "raw", data: msg }
      }
      break
    }

    case "user": {
      const message = asRecord(msg.message)
      const content = Array.isArray(message?.content) ? message.content : []
      let yielded = false

      for (const item of content) {
        const record = asRecord(item)
        if (record?.type !== "tool_result") continue

        yielded = true
        yield {
          type: "tool_result",
          tool_use_id:
            typeof record.tool_use_id === "string" ? record.tool_use_id : undefined,
          content: msg.tool_use_result ?? record.content,
        }
      }

      if (!yielded) {
        yield { type: "raw", data: msg }
      }
      break
    }

    case "result": {
      // Extract token usage from Claude's result
      const usage = asRecord(msg.usage)
      const modelUsage = asRecord(msg.modelUsage)
      let inputTokens: number | undefined
      let contextWindow: number | undefined

      if (usage) {
        const input = usage.input_tokens
        const cacheRead = usage.cache_read_input_tokens
        const cacheCreate = usage.cache_creation_input_tokens
        inputTokens = (typeof input === "number" ? input : 0)
          + (typeof cacheRead === "number" ? cacheRead : 0)
          + (typeof cacheCreate === "number" ? cacheCreate : 0)
      }

      // Extract context window from modelUsage (first model entry)
      if (modelUsage) {
        for (const key of Object.keys(modelUsage)) {
          const entry = asRecord(modelUsage[key])
          if (entry && typeof entry.contextWindow === "number") {
            contextWindow = entry.contextWindow
            break
          }
        }
      }

      yield {
        type: "result",
        session_id: msg.session_id as string | undefined,
        result: typeof msg.result === "string" ? msg.result : undefined,
        cost_usd: msg.cost_usd as number | undefined,
        duration_ms: msg.duration_ms as number | undefined,
        is_error: msg.is_error as boolean | undefined,
        input_tokens: inputTokens,
        context_window: contextWindow,
      }
      break
    }

    default:
      yield { type: "raw", data: msg }
      break
  }
}

function finalizeClaudeToolUse(toolUse: PendingClaudeToolUse): StreamEvent {
  const input = finalizedToolInput(toolUse)
  if (toolUse.name === "AskUserQuestion") {
    const questions = extractQuestions(input)
    const first = questions[0]
    return {
      type: "ask_user_question",
      question: first?.question ?? "The agent asked a follow-up question.",
      options: first?.options,
    }
  }

  if (toolUse.name === "ExitPlanMode") {
    return {
      type: "exit_plan_mode",
      reason: extractReason(input),
    }
  }

  return {
    type: "tool_use",
    name: toolUse.name,
    id: toolUse.id,
    input,
  }
}

function finalizedToolInput(toolUse: PendingClaudeToolUse): unknown {
  const parsed = parsePartialJson(toolUse.partialJson)
  if (parsed !== undefined) {
    return parsed
  }

  if (toolUse.input !== undefined) {
    return toolUse.input
  }

  return toolUse.partialJson || undefined
}

function parsePartialJson(partialJson: string): unknown {
  const trimmed = partialJson.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function extractQuestions(input: unknown): Array<{ question?: string; options?: string[] }> {
  if (!input || typeof input !== "object") return []
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return []
  return questions.map((question) => {
    const record = asRecord(question)
    const options = Array.isArray(record?.options)
      ? record.options
          .map((option) => {
            const optionRecord = asRecord(option)
            if (typeof optionRecord?.label === "string" && optionRecord.label.trim()) {
              return optionRecord.label
            }
            return typeof option === "string" ? option : null
          })
          .filter((option): option is string => Boolean(option))
      : undefined

    return {
      question:
        typeof record?.question === "string" && record.question.trim()
          ? record.question
          : undefined,
      options: options?.length ? options : undefined,
    }
  })
}

function extractReason(input: unknown): string | undefined {
  const record = asRecord(input)
  if (!record) return undefined

  for (const key of ["reason", "message", "text"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }

  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}
