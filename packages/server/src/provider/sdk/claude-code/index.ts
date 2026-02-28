import { Log } from "@/util/log"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk"

const log = Log.create({ service: "claude-code" })

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
  cwd?: string
  /** Restrict which Claude Code tools are available. Empty = all default tools. */
  allowedTools?: string[]
  permissionMode?: PermissionMode
  canUseTool?: CanUseTool
  thinkingEffort?: string
}

export async function* claudeStream(input: ClaudeStreamInput): AsyncGenerator<ClaudeEvent> {
  const controller = new AbortController()
  if (input.abort.aborted) {
    controller.abort()
  } else {
    input.abort.addEventListener("abort", () => controller.abort(), { once: true })
  }

  const effectivePermissionMode =
    input.permissionMode ?? (input.canUseTool ? "default" : "bypassPermissions")

  log.info("starting claude agent sdk query", {
    model: input.modelId,
    resume: input.cliSessionId ?? "(new session)",
    cwd: input.cwd,
    allowedTools: input.allowedTools,
    permissionMode: effectivePermissionMode,
  })

  // Track active tool calls by content-block index
  const toolBlocks: Record<number, { id: string; name: string }> = {}

  try {
    const result = query({
      prompt: input.prompt,
      options: {
        abortController: controller,
        model: input.modelId,
        cwd: input.cwd,
        resume: input.cliSessionId,
        systemPrompt: input.systemPrompt
          ? { type: "preset", preset: "claude_code", append: input.systemPrompt }
          : { type: "preset", preset: "claude_code" },
        // tools restricts WHICH tools are available; allowedTools only auto-approves
        tools: input.allowedTools?.length
          ? input.allowedTools
          : { type: "preset", preset: "claude_code" },
        permissionMode: effectivePermissionMode,
        allowDangerouslySkipPermissions: effectivePermissionMode === "bypassPermissions",
        canUseTool: input.canUseTool,
        includePartialMessages: true,
        ...(toThinkingOption(input.thinkingEffort) !== undefined
          ? { thinking: toThinkingOption(input.thinkingEffort) }
          : {}),
      },
    })

    for await (const msg of result) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") yield { type: "step-start" }
          break

        case "stream_event":
          // msg.event is BetaRawMessageStreamEvent — same shape as the raw CLI JSON events
          yield* parseClaudeApiEvent(msg.event, toolBlocks)
          break

        case "result":
          yield { type: "step-end" }
          if (msg.session_id) yield { type: "done", sessionId: msg.session_id }
          break
      }
    }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      yield { type: "error", message: String(e?.message ?? err) }
    }
  }
}

export type CompletionEvent =
  | { type: "delta"; text: string }
  | { type: "error"; error: string }
  | { type: "done" }

export async function* completionStream(input: {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
  abort?: AbortSignal
}): AsyncGenerator<CompletionEvent> {
  const controller = new AbortController()
  if (input.abort?.aborted) {
    controller.abort()
  } else if (input.abort) {
    input.abort.addEventListener("abort", () => controller.abort(), { once: true })
  }

  log.info("starting completion stream", { model: input.model })

  // Strip CLAUDECODE env var so the SDK subprocess doesn't think it's nested
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDECODE

  let accumulated = ""

  try {
    const result = query({
      prompt: input.prompt,
      options: {
        abortController: controller,
        model: input.model,
        maxTurns: 1,
        tools: [],
        persistSession: false,
        systemPrompt: input.systemPrompt ?? "",
        thinking: { type: "disabled" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env,
      },
    })

    for await (const msg of result) {
      const m = msg as Record<string, unknown>
      switch (msg.type) {
        case "auth_status": {
          if (m["error"]) {
            yield { type: "error", error: String(m["error"]) }
            return
          }
          break
        }

        // The SDK emits "assistant" messages with the full message content.
        // Extract text blocks from message.content[].
        case "assistant": {
          const message = m["message"] as Record<string, unknown> | undefined
          const content = message?.["content"] as Array<Record<string, unknown>> | undefined
          if (!content) break

          for (const block of content) {
            if (block["type"] === "text" && block["text"]) {
              let text = block["text"] as string

              // Check stop sequences
              if (input.stopSequences?.length) {
                for (const stop of input.stopSequences) {
                  const stopIdx = text.indexOf(stop)
                  if (stopIdx !== -1) {
                    text = text.slice(0, stopIdx)
                    if (text) yield { type: "delta", text }
                    yield { type: "done" }
                    return
                  }
                }
              }

              if (text) yield { type: "delta", text }
              accumulated += text
            }
          }
          break
        }

        case "result": {
          const subtype = m["subtype"] as string | undefined
          if (subtype?.startsWith("error_")) {
            const errors = (m["errors"] as string[]) ?? []
            yield { type: "error", error: errors.join(", ") || "Unknown error" }
            return
          }
          // If no text was yielded from assistant messages, use the result text
          if (!accumulated) {
            const resultText = m["result"] as string | undefined
            if (resultText) {
              yield { type: "delta", text: resultText }
            }
          }
          break
        }
      }
    }

    yield { type: "done" }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name !== "AbortError") {
      yield { type: "error", error: String(e?.message ?? err) }
    }
  }
}

function toThinkingOption(
  effort: string | undefined,
): { type: "disabled" } | { type: "enabled"; budgetTokens: number } | undefined {
  switch (effort) {
    case "low":    return { type: "enabled", budgetTokens: 2000 }
    case "medium": return { type: "enabled", budgetTokens: 8000 }
    case "high":   return { type: "enabled", budgetTokens: 20000 }
    case "off":    return { type: "disabled" }
    default:       return undefined
  }
}

function* parseClaudeApiEvent(
  event: Record<string, unknown>,
  toolBlocks: Record<number, { id: string; name: string }>,
): Generator<ClaudeEvent> {
  if (!event || typeof event !== "object") return

  switch (event["type"]) {
    case "message_start": {
      for (const key of Object.keys(toolBlocks)) {
        delete toolBlocks[Number(key)]
      }
      yield { type: "message-boundary" }
      break
    }

    case "content_block_start": {
      const index = (event["index"] as number) ?? 0
      const block = event["content_block"] as Record<string, unknown> | undefined
      if (!block) break
      if (block["type"] === "tool_use") {
        const toolInfo = {
          id: (block["id"] as string) ?? `tool-${index}`,
          name: (block["name"] as string) ?? "",
        }
        toolBlocks[index] = toolInfo
        yield { type: "tool-start", id: toolInfo.id, name: toolInfo.name }
      }
      break
    }

    case "content_block_delta": {
      const index = (event["index"] as number) ?? 0
      const delta = event["delta"] as Record<string, unknown> | undefined
      if (!delta) break

      if (delta["type"] === "text_delta" && delta["text"]) {
        yield { type: "text-delta", text: delta["text"] as string }
      } else if (delta["type"] === "thinking_delta" && delta["thinking"]) {
        yield { type: "reasoning-delta", id: `reasoning-${index}`, text: delta["thinking"] as string }
      } else if (delta["type"] === "input_json_delta" && delta["partial_json"] != null) {
        const tool = toolBlocks[index]
        if (tool) yield { type: "tool-input-delta", id: tool.id, partial: delta["partial_json"] as string }
      }
      break
    }

    case "content_block_stop": {
      const index = (event["index"] as number) ?? 0
      const tool = toolBlocks[index]
      if (tool) {
        yield { type: "tool-end", id: tool.id }
        delete toolBlocks[index]
      }
      break
    }
  }
}
