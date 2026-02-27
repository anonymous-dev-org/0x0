import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type { ModelMessage } from "ai"
import type { Agent } from "@/runtime/agent/agent"
import type { MessageV2 } from "./message-v2"
import { SystemPrompt } from "./system"
import { claudeStream } from "@/provider/sdk/claude-code"
import { codexAppServerStream, type CodexApprovalDecision } from "@/provider/sdk/codex-app-server"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  // ─────────────────────────────────────────────────────────────────────────────
  // Event types emitted by CLI bridges
  // ─────────────────────────────────────────────────────────────────────────────

  export type CliEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; id: string; text: string }
    | { type: "tool-start"; id: string; tool: string; command?: string }
    | { type: "tool-input-delta"; id: string; partial: string }
    | { type: "tool-end"; id: string; output: string; exitCode?: number }
    | { type: "file-change"; id: string; files: Array<{ path: string; kind: string }> }
    | { type: "step-start" }
    | { type: "step-end" }
    | { type: "done"; cliSessionId?: string; codexThreadId?: string }
    | { type: "error"; error: Error }

  // ─────────────────────────────────────────────────────────────────────────────
  // StreamInput — kept compatible with existing callers in prompt.ts
  // (the CLI bridges only use the fields they need)
  // ─────────────────────────────────────────────────────────────────────────────

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools?: Record<string, any>
    retries?: number
    /** CLI session ID for resuming a Claude Code session */
    cliSessionId?: string
    /** Codex thread ID for resuming a Codex session */
    codexThreadId?: string
    /** Called before each Claude tool execution; return deny to block */
    canUseTool?: CanUseTool
    /** Called before Codex executes a command or applies file changes */
    codexApproval?: {
      onCommand: (params: { command: string; cwd: string; reason?: string }) => Promise<CodexApprovalDecision>
      onFileChange: (params: { reason?: string }) => Promise<CodexApprovalDecision>
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // System prompt composition (unchanged from before)
  // ─────────────────────────────────────────────────────────────────────────────

  export async function composeSystemParts(input: {
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    user: MessageV2.User
  }): Promise<string[]> {
    const skill = input.system.find((item) => !!item?.trim())
    const agentPrompt = [input.agent.prompt, transparencySection(input.agent)].filter(Boolean).join("\n\n")
    return SystemPrompt.compose({ agent: agentPrompt, skill })
  }

  export function transparencySection(agent: Agent.Info): string {
    const actions = agent.actions ?? {}
    const actionsEntries = Object.entries(actions)
    const actionsStr =
      actionsEntries.length > 0
        ? actionsEntries
            .map(
              ([provider, tools]) =>
                `${provider}: ${Object.entries(tools)
                  .map(([t, p]) => `${t}=${p}`)
                  .join(", ")}`,
            )
            .join("; ")
        : "(default: ask for all)"
    const knowledgeBase = agent.knowledgeBase ?? []
    const knowledge = knowledgeBase.length > 0 ? knowledgeBase.join("\n- ") : "(none)"
    return [
      "## Effective Agent Configuration",
      `- Agent ID: ${agent.name}`,
      `- Agent Name: ${agent.displayName ?? agent.name}`,
      `- Actions: ${actionsStr}`,
      `- Thinking Effort: ${agent.thinkingEffort ?? "(unset)"}`,
      `- Knowledge Base:\n- ${knowledge}`,
    ].join("\n")
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Extract the latest user prompt text from the messages array
  // ─────────────────────────────────────────────────────────────────────────────

  function extractUserPrompt(messages: ModelMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg || msg.role !== "user") continue
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join("\n")
      }
    }
    return ""
  }

  function extractMessageText(msg: ModelMessage): string {
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .filter(Boolean)
        .join("\n")
    }
    return ""
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Build user prompt with conversation context when switching providers.
  // Each CLI SDK manages its own session history via session/thread IDs, so
  // when the target provider has no existing session, prior conversation
  // context would be lost. This prepends the history to the user prompt.
  // ─────────────────────────────────────────────────────────────────────────────

  function buildPromptWithContext(messages: ModelMessage[], hasExistingSession: boolean): string {
    const userPrompt = extractUserPrompt(messages)
    if (hasExistingSession) return userPrompt

    // Find the last user message index
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIdx = i
        break
      }
    }

    // No prior conversation history
    if (lastUserIdx <= 0) return userPrompt

    const prior = messages.slice(0, lastUserIdx)
    const lines: string[] = []
    for (const msg of prior) {
      if (!msg) continue
      const text = extractMessageText(msg).trim()
      if (!text) continue
      lines.push(`${msg.role}: ${text}`)
    }
    if (lines.length === 0) return userPrompt

    return [
      "<conversation-context>",
      "The following is the conversation history from a previous agent. Use it as context for the user's request.",
      "",
      ...lines,
      "</conversation-context>",
      "",
      userPrompt,
    ].join("\n")
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main stream function — routes to the appropriate CLI bridge
  // ─────────────────────────────────────────────────────────────────────────────

  export async function* stream(input: StreamInput): AsyncGenerator<CliEvent> {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)

    l.info("stream", { modelID: input.model.id, providerID: input.model.providerID })

    const systemParts = await composeSystemParts(input)
    const systemPrompt = systemParts.filter(Boolean).join("\n\n")

    const providerID = input.model.providerID
    const hasExistingSession =
      (providerID === "claude-code" && !!input.cliSessionId) ||
      (providerID === "codex" && !!input.codexThreadId)
    const userPrompt = buildPromptWithContext(input.messages, hasExistingSession)

    if (!userPrompt.trim()) {
      l.warn("empty user prompt, skipping stream")
      return
    }

    if (providerID === "claude-code") {
      yield* claudeCodeBridge(input, userPrompt, systemPrompt)
    } else if (providerID === "codex") {
      yield* codexBridge(input, userPrompt, systemPrompt)
    } else {
      yield {
        type: "error",
        error: new Error(`Unknown CLI provider: ${providerID}. Expected "claude-code" or "codex".`),
      }
    }
  }

  async function* claudeCodeBridge(
    input: StreamInput,
    userPrompt: string,
    systemPrompt: string,
  ): AsyncGenerator<CliEvent> {
    for await (const event of claudeStream({
      modelId: input.model.id,
      prompt: userPrompt,
      systemPrompt: systemPrompt || undefined,
      cliSessionId: input.cliSessionId,
      abort: input.abort,
      canUseTool: input.canUseTool,
    })) {
      switch (event.type) {
        case "text-delta":
          yield { type: "text-delta", text: event.text }
          break
        case "reasoning-delta":
          yield { type: "reasoning-delta", id: event.id, text: event.text }
          break
        case "tool-start":
          yield { type: "tool-start", id: event.id, tool: event.name }
          break
        case "tool-input-delta":
          yield { type: "tool-input-delta", id: event.id, partial: event.partial }
          break
        case "tool-end":
          yield { type: "tool-end", id: event.id, output: "" }
          break
        case "step-start":
          yield { type: "step-start" }
          break
        case "step-end":
          yield { type: "step-end" }
          break
        case "done":
          yield { type: "done", cliSessionId: event.sessionId }
          break
        case "error":
          yield { type: "error", error: new Error(event.message) }
          break
      }
    }
  }

  async function* codexBridge(
    input: StreamInput,
    userPrompt: string,
    systemPrompt: string,
  ): AsyncGenerator<CliEvent> {
    for await (const event of codexAppServerStream({
      modelId: input.model.id,
      prompt: userPrompt,
      systemPrompt: systemPrompt || undefined,
      threadId: input.codexThreadId,
      abort: input.abort,
      cwd: typeof input.agent.options?.cwd === "string" ? input.agent.options.cwd : undefined,
      approvalPolicy: "on-request",
      onCommandApproval: input.codexApproval?.onCommand,
      onFileChangeApproval: input.codexApproval?.onFileChange,
    })) {
      switch (event.type) {
        case "text-delta":
          yield { type: "text-delta", text: event.text }
          break
        case "reasoning-delta":
          yield { type: "reasoning-delta", id: event.id, text: event.text }
          break
        case "tool-start":
          yield { type: "tool-start", id: event.id, tool: event.tool, command: event.command }
          break
        case "tool-output":
          yield { type: "tool-input-delta", id: event.id, partial: event.output }
          break
        case "tool-end":
          yield { type: "tool-end", id: event.id, output: event.output, exitCode: event.exitCode }
          break
        case "file-change":
          yield { type: "file-change", id: event.id, files: event.files }
          break
        case "step-start":
          yield { type: "step-start" }
          break
        case "step-end":
          yield { type: "step-end" }
          break
        case "done":
          yield { type: "done", codexThreadId: event.threadId }
          break
        case "error":
          yield { type: "error", error: new Error(event.message) }
          break
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Convenience: collect all text from a stream (for title generation etc.)
  // ─────────────────────────────────────────────────────────────────────────────

  export async function getText(input: StreamInput): Promise<string> {
    let text = ""
    for await (const event of stream(input)) {
      if (event.type === "text-delta") text += event.text
      if (event.type === "error") throw event.error
    }
    return text
  }
}
