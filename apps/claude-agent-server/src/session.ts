// Per-session state machine and prompt loop.
//
// States: idle → running → waiting_for_tool_result → running → ... → done
//
// On session/prompt arrival:
//   1. Push user message into history.
//   2. Stream Anthropic; for each text delta emit agent_message_chunk;
//      for tool_use blocks emit tool_call and collect the input deltas.
//   3. When stop_reason=tool_use, dispatch every collected tool via
//      tools.ts (which forwards to client via ctx.request), collect
//      results into tool_result blocks, then re-stream.
//   4. When stop_reason ∈ {end_turn, max_tokens, cancelled}, resolve.

import { type ClaudeClient, makeAnthropicClient } from "./claude"
import { ALL_TOOLS, toAnthropicTools, toolByName } from "./tools"
import type {
  ConfigOption,
  SessionUpdate,
  StopReason,
  ToolKind,
} from "./types"
import type {
  ContentBlock,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages"

type AssistantBlock = TextBlockParam | ToolUseBlockParam | ThinkingBlockParam

export interface SessionDeps {
  sessionId: string
  notify: (update: SessionUpdate) => void
  request: <T = unknown>(method: string, params: unknown) => Promise<T>
}

export interface SessionOptions {
  defaultModel: string
  models: string[]
  claude?: ClaudeClient
  systemPrompt?: string
  maxToolIterations?: number
  maxTokens?: number
}

const DEFAULT_SYSTEM = [
  "You are Claude, integrated into the 0x0 nvim IDE.",
  "Edit code by calling the `write_file` tool with the new full file content.",
  "Read code with `read_file` before editing.",
  "Keep edits minimal and focused on the user's request.",
].join(" ")

const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
  read_file: "read",
  write_file: "edit",
}

export class Session {
  readonly id: string
  readonly cwd: string
  private model: string
  private mode = "default"
  private readonly models: string[]
  private readonly history: MessageParam[] = []
  private readonly deps: SessionDeps
  private claudeOverride: ClaudeClient | undefined
  private claudeInstance: ClaudeClient | null = null
  private readonly system: string
  private readonly maxToolIterations: number
  private readonly maxTokens: number
  private abortController: AbortController | null = null
  private state: "idle" | "running" | "waiting_for_tool_result" | "done" = "idle"

  constructor(id: string, cwd: string, deps: SessionDeps, opts: SessionOptions) {
    this.id = id
    this.cwd = cwd
    this.deps = deps
    this.model = opts.defaultModel
    this.models = opts.models
    this.claudeOverride = opts.claude
    this.system = opts.systemPrompt ?? DEFAULT_SYSTEM
    this.maxToolIterations = opts.maxToolIterations ?? 8
    this.maxTokens = opts.maxTokens ?? 8192
  }

  configOptions(): ConfigOption[] {
    return [
      {
        category: "model",
        currentValue: this.model,
        options: this.models.map(m => ({ value: m, name: m })),
      },
      {
        category: "mode",
        currentValue: this.mode,
        options: [
          { value: "default", name: "default" },
          { value: "plan", name: "plan" },
        ],
      },
    ]
  }

  setModel(modelId: string): void {
    this.model = modelId
  }

  setMode(mode: string): void {
    this.mode = mode
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
  }

  async prompt(promptBlocks: { type: string; text?: string; uri?: string }[]): Promise<StopReason> {
    // T1.6: refuse to enter prompt() while another is in flight.
    if (this.state !== "idle" && this.state !== "done") {
      throw new Error("session is busy")
    }
    const userText = promptBlocks
      .filter(b => b.type === "text" && typeof b.text === "string")
      .map(b => b.text as string)
      .join("\n\n")
    this.history.push({ role: "user", content: userText })
    this.abortController = new AbortController()

    try {
      for (let iter = 0; iter < this.maxToolIterations; iter++) {
        this.state = "running"
        const round = await this.runOneRound()
        if (round.stopReason === "tool_use" && round.toolUses.length > 0) {
          this.state = "waiting_for_tool_result"
          const toolResults = await this.dispatchTools(round.toolUses)
          // Append the assistant message with its (text|tool_use|thinking)
          // blocks, then the user message containing the tool_result blocks.
          // This matches Anthropic's tool-use loop contract. (T1.7)
          if (round.assistantBlocks.length > 0) {
            this.history.push({ role: "assistant", content: round.assistantBlocks })
          }
          this.history.push({ role: "user", content: toolResults })
          continue
        }
        // T1.8: skip the assistant push entirely when nothing was emitted,
        // rather than appending an empty content array that Anthropic rejects.
        if (round.assistantBlocks.length > 0) {
          this.history.push({ role: "assistant", content: round.assistantBlocks })
        }
        this.state = "done"
        return round.stopReason === "tool_use" ? "end_turn" : round.stopReason
      }
      this.state = "done"
      return "max_tokens"
    } catch (e) {
      this.state = "done"
      if (this.abortController?.signal.aborted) {
        return "cancelled"
      }
      throw e
    } finally {
      this.abortController = null
    }
  }

  /** Return the active abort signal, or a pre-aborted one if no
   * controller is set. Never substitutes a never-firing signal. (T1.9) */
  private activeSignal(): AbortSignal {
    if (this.abortController) {
      return this.abortController.signal
    }
    return AbortSignal.abort()
  }

  private async runOneRound(): Promise<{
    stopReason: StopReason
    assistantBlocks: AssistantBlock[]
    toolUses: { id: string; name: string; input: Record<string, unknown> }[]
  }> {
    const signal = this.activeSignal()
    if (!this.claudeInstance) {
      this.claudeInstance = this.claudeOverride ?? makeAnthropicClient()
    }
    const events = this.claudeInstance.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: this.system,
      messages: this.history,
      tools: toAnthropicTools(),
      signal,
    })

    type Pending = {
      index: number
      kind: "text" | "tool_use" | "thinking"
      block: ContentBlock | null
      text: string
      toolInputJson: string
      signature: string
    }
    const byIndex = new Map<number, Pending>()
    let stopReason: StopReason = "end_turn"

    for await (const event of events as AsyncIterable<RawMessageStreamEvent>) {
      switch (event.type) {
        case "content_block_start": {
          const cb = event.content_block
          const kind: "text" | "tool_use" | "thinking" =
            cb.type === "text" ? "text" : cb.type === "tool_use" ? "tool_use" : "thinking"
          byIndex.set(event.index, {
            index: event.index,
            kind,
            block: cb,
            text: "",
            toolInputJson: "",
            signature: "",
          })
          if (cb.type === "tool_use") {
            this.deps.notify({
              sessionUpdate: "tool_call",
              toolCallId: cb.id,
              kind: TOOL_KIND_BY_NAME[cb.name] ?? "other",
              title: cb.name,
              status: "in_progress",
              rawInput: {},
            })
          }
          break
        }
        case "content_block_delta": {
          const p = byIndex.get(event.index)
          if (!p) break
          const delta = event.delta
          if (delta.type === "text_delta") {
            p.text += delta.text
            this.deps.notify({
              sessionUpdate: "agent_message_chunk",
              content: { text: delta.text },
            })
          } else if (delta.type === "input_json_delta") {
            p.toolInputJson += delta.partial_json
          } else if (delta.type === "thinking_delta") {
            p.text += delta.thinking
            this.deps.notify({
              sessionUpdate: "agent_thought_chunk",
              content: { text: delta.thinking },
            })
          } else if (delta.type === "signature_delta") {
            // T1.7: capture the thinking-block signature so we can echo
            // it back on subsequent rounds when extended thinking is on.
            p.signature += delta.signature
          }
          break
        }
        case "content_block_stop":
          break
        case "message_delta":
          if (event.delta.stop_reason) {
            stopReason = mapStopReason(event.delta.stop_reason)
          }
          break
        default:
          break
      }
    }

    const assistantBlocks: AssistantBlock[] = []
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = []
    const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index)
    for (const p of ordered) {
      if (p.kind === "text" && p.text.length > 0) {
        assistantBlocks.push({ type: "text", text: p.text })
      } else if (p.kind === "thinking" && p.signature.length > 0) {
        // T1.7: only echo thinking back when we have a signature. Without
        // one, Anthropic will not accept the block on the next round.
        assistantBlocks.push({ type: "thinking", thinking: p.text, signature: p.signature })
      } else if (p.kind === "tool_use" && p.block && p.block.type === "tool_use") {
        const tu = p.block as ToolUseBlock
        let input: Record<string, unknown> = {}
        if (p.toolInputJson.length > 0) {
          try {
            const parsed = JSON.parse(p.toolInputJson)
            if (parsed && typeof parsed === "object") {
              input = parsed as Record<string, unknown>
            }
          } catch {
            input = {}
          }
        }
        assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input })
        toolUses.push({ id: tu.id, name: tu.name, input })
      }
    }

    return { stopReason, assistantBlocks, toolUses }
  }

  private async dispatchTools(
    toolUses: { id: string; name: string; input: Record<string, unknown> }[]
  ): Promise<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[]> {
    const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = []
    for (const tu of toolUses) {
      const tool = toolByName(tu.name)
      if (!tool) {
        this.deps.notify({
          sessionUpdate: "tool_call_update",
          toolCallId: tu.id,
          status: "failed",
          content: [{ type: "text", text: "unknown tool: " + tu.name }],
        })
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "tool not found: " + tu.name,
          is_error: true,
        })
        continue
      }
      try {
        const output = await tool.dispatch(tu.input, {
          sessionId: this.id,
          request: this.deps.request,
          notify: this.deps.notify,
          signal: this.activeSignal(),
        })
        this.deps.notify({
          sessionUpdate: "tool_call_update",
          toolCallId: tu.id,
          status: "completed",
        })
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        })
      } catch (e) {
        const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)
        this.deps.notify({
          sessionUpdate: "tool_call_update",
          toolCallId: tu.id,
          status: "failed",
          content: [{ type: "text", text: msg }],
        })
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        })
      }
    }
    return results
  }
}

function mapStopReason(s: string): StopReason {
  switch (s) {
    case "end_turn":
      return "end_turn"
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "max_tokens"
    case "stop_sequence":
      return "end_turn"
    default:
      return "end_turn"
  }
}

// Re-export ALL_TOOLS for tests
export { ALL_TOOLS }
