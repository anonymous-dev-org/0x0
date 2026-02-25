import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionStatus } from "./status"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { PermissionNext } from "@/permission/next"
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"

function providerToolPermission(toolName: string): string {
  switch (toolName) {
    case "Bash": return "bash"
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": return "edit"
    case "Read": return "read"
    case "Glob":
    case "Grep": return "search"
    case "Task": return "task"
    case "WebFetch":
    case "WebSearch": return "web"
    default: return toolName.toLowerCase()
  }
}

function providerToolPattern(toolName: string, input: Record<string, unknown>): string {
  function field(...keys: string[]): string {
    for (const key of keys) {
      const val = input[key]
      if (typeof val === "string" && val) return val
    }
    return "*"
  }
  switch (toolName) {
    case "Bash": return field("command")
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": return field("file_path", "path")
    case "Read": return field("file_path")
    case "Glob": return field("pattern")
    case "Grep": return field("path", "pattern")
    case "Task": return field("prompt", "description")
    case "WebFetch": return field("url")
    case "WebSearch": return field("query")
    default: return "*"
  }
}

export namespace SessionProcessor {
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolParts: Record<string, MessageV2.ToolPart> = {}
    let currentText: MessageV2.TextPart | undefined
    let currentReasoning: Record<string, MessageV2.ReasoningPart> = {}
    let snapshot: string | undefined
    let lastPhase: string | undefined

    function setPhase(phase: "thinking" | "writing" | "tool", detail?: string) {
      const key = `${phase}:${detail ?? ""}`
      if (key === lastPhase) return
      lastPhase = key
      SessionStatus.set(input.sessionID, { type: "busy", phase, detail })
    }

    function formatToolDetail(tool: string, command?: string): string {
      if (command) {
        const truncated = command.length > 40 ? command.slice(0, 40) + "\u2026" : command
        return `${tool}: ${truncated}`
      }
      return tool
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolParts[toolCallID]
      },
      async process(streamInput: LLM.StreamInput): Promise<"continue" | "stop"> {
        log.info("process", { sessionID: input.sessionID, model: streamInput.model.id })

        // Look up the current CLI session IDs from session storage
        const sessionInfo = await Session.get(input.sessionID).catch(() => null)
        const cliSessionId = streamInput.cliSessionId ?? sessionInfo?.cliSessionId
        const codexThreadId = streamInput.codexThreadId ?? sessionInfo?.codexThreadId

        const providerID = streamInput.model.providerID
        const agentActions = streamInput.agent.actions?.[providerID] ?? {}
        const agentName = streamInput.agent.name

        const canUseTool = async (
          toolName: string,
          toolInput: Record<string, unknown>,
        ): Promise<PermissionResult> => {
          const policy = agentActions[toolName]
          if (policy === "allow") return { behavior: "allow" }
          if (policy === "deny")
            return { behavior: "deny", message: `Tool "${toolName}" is denied by agent action policy.` }

          const session = await Session.get(input.sessionID).catch(() => null)
          try {
            await PermissionNext.ask({
              sessionID: input.sessionID,
              permission: providerToolPermission(toolName),
              patterns: [providerToolPattern(toolName, toolInput)],
              metadata: { tool: toolName, provider: providerID, agent: agentName },
              always: ["*"],
              ruleset: PermissionNext.merge(streamInput.agent.permission, session?.permission ?? []),
            })
            return { behavior: "allow" }
          } catch (e) {
            return { behavior: "deny", message: e instanceof Error ? e.message : "Permission denied." }
          }
        }

        const codexApproval = {
          async onCommand(params: { command: string; cwd: string; reason?: string }) {
            const policy = agentActions.commandExecution
            if (policy === "allow") return "accept" as const
            if (policy === "deny") return "decline" as const

            const session = await Session.get(input.sessionID).catch(() => null)
            try {
              await PermissionNext.ask({
                sessionID: input.sessionID,
                permission: "bash",
                patterns: [params.command],
                metadata: {
                  tool: "commandExecution",
                  provider: providerID,
                  agent: agentName,
                  command: params.command,
                  cwd: params.cwd,
                  reason: params.reason,
                },
                always: ["*"],
                ruleset: PermissionNext.merge(streamInput.agent.permission, session?.permission ?? []),
              })
              return "accept" as const
            } catch {
              return "decline" as const
            }
          },
          async onFileChange(params: { reason?: string }) {
            const policy = agentActions.fileChange
            if (policy === "allow") return "accept" as const
            if (policy === "deny") return "decline" as const

            const session = await Session.get(input.sessionID).catch(() => null)
            try {
              await PermissionNext.ask({
                sessionID: input.sessionID,
                permission: "edit",
                patterns: ["*"],
                metadata: {
                  tool: "fileChange",
                  provider: providerID,
                  agent: agentName,
                  reason: params.reason,
                },
                always: ["*"],
                ruleset: PermissionNext.merge(streamInput.agent.permission, session?.permission ?? []),
              })
              return "accept" as const
            } catch {
              return "decline" as const
            }
          },
        }

        const enrichedInput: LLM.StreamInput = {
          ...streamInput,
          cliSessionId,
          codexThreadId,
          canUseTool,
          codexApproval,
        }

        try {
          SessionStatus.set(input.sessionID, { type: "busy" })
          snapshot = await Snapshot.track()

          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: input.assistantMessage.id,
            sessionID: input.sessionID,
            snapshot,
            type: "step-start",
          })

          for await (const event of LLM.stream(enrichedInput)) {
            input.abort.throwIfAborted()

            switch (event.type) {
              // ── Text ───────────────────────────────────────────────────────

              case "text-delta": {
                setPhase("writing")
                if (!currentText) {
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: { start: Date.now() },
                  }
                }
                currentText.text += event.text
                await Session.updatePart({ part: currentText, delta: event.text })
                break
              }

              // ── Reasoning ─────────────────────────────────────────────────

              case "reasoning-delta": {
                setPhase("thinking")
                let part = currentReasoning[event.id]
                if (!part) {
                  part = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: { start: Date.now() },
                  }
                  currentReasoning[event.id] = part
                }
                part.text += event.text
                await Session.updatePart({ part, delta: event.text })
                break
              }

              // ── Tool call starts (pending → running display) ───────────────

              case "tool-start": {
                setPhase("tool", formatToolDetail(event.tool, event.command))
                finalizeText()
                const toolInput = event.command ? { command: event.command } : {}
                const toolPart = (await Session.updatePart({
                  id: Identifier.ascending("part"),
                  messageID: input.assistantMessage.id,
                  sessionID: input.assistantMessage.sessionID,
                  type: "tool",
                  tool: event.tool,
                  callID: event.id,
                  state: {
                    status: "running",
                    input: toolInput,
                    title: event.command ?? "",
                    time: { start: Date.now() },
                    metadata: { raw: "" },
                  },
                })) as MessageV2.ToolPart
                toolParts[event.id] = toolPart
                break
              }

              case "tool-input-delta": {
                const toolPart = toolParts[event.id]
                if (toolPart && toolPart.state.status === "running") {
                  const raw = (toolPart.state.metadata?.raw ?? "") + event.partial
                  toolPart.state = { ...toolPart.state, metadata: { ...toolPart.state.metadata, raw } }
                  try {
                    const parsed = JSON.parse(raw)
                    if (typeof parsed === "object" && parsed !== null) {
                      const extracted = providerToolPattern(toolPart.tool, parsed)
                      if (extracted !== "*" && toolPart.state.status === "running" && toolPart.state.title !== extracted) {
                        toolPart.state = { ...toolPart.state, title: extracted }
                        Session.updatePart(toolPart).catch((e) => log.warn("failed to update tool part title", { error: e }))
                      }
                    }
                  } catch {}
                }
                break
              }

              case "tool-end": {
                setPhase("thinking")
                const toolPart = toolParts[event.id]
                if (toolPart) {
                  const startTime =
                    toolPart.state.status === "running"
                      ? toolPart.state.time.start
                      : Date.now()

                  // Transition pending → running → completed in one shot
                  const currentInput =
                    toolPart.state.status === "running" || toolPart.state.status === "pending"
                      ? toolPart.state.input
                      : {}

                  await Session.updatePart({
                    ...toolPart,
                    state: {
                      status: "completed",
                      input: currentInput,
                      output: event.output,
                      title: "",
                      metadata: { exitCode: event.exitCode },
                      time: { start: startTime, end: Date.now() },
                    },
                  })
                  delete toolParts[event.id]
                } else {
                  // Tool we haven't seen start event for — create completed directly
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: "bash",
                    callID: event.id,
                    state: {
                      status: "completed",
                      input: {},
                      output: event.output,
                      title: "",
                      metadata: { exitCode: event.exitCode },
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                }
                break
              }

              // ── File changes (Codex) ───────────────────────────────────────

              case "file-change": {
                finalizeText()
                if (event.files.length > 0) {
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "patch",
                    hash: event.id,
                    files: event.files.map((f) => f.path),
                  })
                }
                break
              }

              // ── Step boundaries ───────────────────────────────────────────

              case "step-start": {
                lastPhase = undefined
                SessionStatus.set(input.sessionID, { type: "busy" })
                snapshot = await Snapshot.track()
                break
              }

              case "step-end": {
                finalizeText()
                finalizeReasoning()
                finalizeTools()

                input.assistantMessage.finish = "end-turn"
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  reason: "end_turn",
                  snapshot: await Snapshot.track(),
                  messageID: input.assistantMessage.id,
                  sessionID: input.assistantMessage.sessionID,
                  type: "step-finish",
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  cost: 0,
                })

                if (snapshot) {
                  const patch = await Snapshot.patch(snapshot)
                  if (patch.files.length) {
                    await Session.updatePart({
                      id: Identifier.ascending("part"),
                      messageID: input.assistantMessage.id,
                      sessionID: input.sessionID,
                      type: "patch",
                      hash: patch.hash,
                      files: patch.files,
                    })
                  }
                  snapshot = undefined
                }

                SessionSummary.summarize({
                  sessionID: input.sessionID,
                  messageID: input.assistantMessage.parentID,
                })
                break
              }

              // ── Done — store CLI session ID ───────────────────────────────

              case "done": {
                if (event.cliSessionId || event.codexThreadId) {
                  await Session.update(input.sessionID, (draft) => {
                    if (event.cliSessionId) draft.cliSessionId = event.cliSessionId
                    if (event.codexThreadId) draft.codexThreadId = event.codexThreadId
                  })
                }
                break
              }

              // ── Error ─────────────────────────────────────────────────────

              case "error": {
                log.error("CLI stream error", { error: event.error })
                const errorObj = MessageV2.fromError(event.error, { providerID: input.model.providerID })
                input.assistantMessage.error = errorObj
                Bus.publish(Session.Event.Error, {
                  sessionID: input.assistantMessage.sessionID,
                  error: errorObj,
                })
                SessionStatus.set(input.sessionID, { type: "idle" })
                break
              }
            }
          }
        } catch (e: any) {
          if (e?.name === "AbortError" || e?.code === "ERR_USE_AFTER_CLOSE") {
            // Aborted — clean up gracefully
          } else {
            log.error("processor error", { error: e })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error,
            })
          }
        } finally {
          finalizeText()
          finalizeReasoning()
          finalizeTools()

          if (snapshot) {
            const patch = await Snapshot.patch(snapshot).catch(() => ({ files: [], hash: "" }))
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
          }

          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          SessionStatus.set(input.sessionID, { type: "idle" })
        }

        if (input.assistantMessage.error) return "stop"
        return "continue"
      },
    }

    function finalizeText() {
      if (!currentText) return
      currentText.text = currentText.text.trimEnd()
      currentText.time = { start: currentText.time?.start ?? Date.now(), end: Date.now() }
      Session.updatePart(currentText).catch((e) =>
        log.error("failed to persist finalized text part", { error: e, messageID: currentText!.messageID }),
      )
      currentText = undefined
    }

    function finalizeReasoning() {
      for (const part of Object.values(currentReasoning)) {
        part.text = part.text.trimEnd()
        part.time = { start: part.time.start, end: Date.now() }
        Session.updatePart(part).catch((e) =>
          log.error("failed to persist finalized reasoning part", { error: e, messageID: part.messageID }),
        )
      }
      currentReasoning = {}
    }

    function finalizeTools() {
      for (const [id, toolPart] of Object.entries(toolParts)) {
        if (toolPart.state.status === "pending" || toolPart.state.status === "running") {
          Session.updatePart({
            ...toolPart,
            state: {
              status: "error",
              input: toolPart.state.input,
              error: "Tool execution aborted",
              time: {
                start:
                  "time" in toolPart.state && toolPart.state.time ? toolPart.state.time.start : Date.now(),
                end: Date.now(),
              },
            },
          }).catch((e) => log.error("failed to mark tool as aborted", { error: e, toolCallID: id }))
        }
        delete toolParts[id]
      }
    }

    return result
  }
}
