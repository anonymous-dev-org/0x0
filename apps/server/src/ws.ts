import {
  type ChatRequest,
  type ChatStreamEvent,
  type ProviderId,
  type WebSocketClientMessage,
  WebSocketClientMessageSchema,
  type WebSocketServerMessage,
  WebSocketServerMessageSchema,
} from "@anonymous-dev/0x0-contracts"
import type { ServerWebSocket, WebSocketHandler } from "bun"
import { AGENT_SYSTEM_PROMPT } from "./agent/prompts"
import { runAgentTurn } from "./agent/runner"
import { getDefaultProviderId, toCompletionChatRequest, toInlineEditChatRequest } from "./one-shot"
import type { ProviderRegistry } from "./providers"
import { publicRefName, type SessionRecord, type SessionSnapshot, WorktreeManager } from "./worktree"

type SendMessage = (message: WebSocketServerMessage) => void

type ActiveRun = {
  controller: AbortController
  messages: SessionRecord["messages"]
  queued: SessionRecord["messages"]
}

type ActiveEntry = AbortController | ActiveRun

type SessionManager = {
  listSessions(): SessionRecord[]
  getSession(sessionId: string): SessionRecord | undefined
  createSession(input: { repoRoot: string; provider: ProviderId; model: string }): Promise<SessionRecord>
  updateSessionMessages(sessionId: string, messages: SessionRecord["messages"]): Promise<SessionRecord>
  sync(sessionId: string): Promise<SessionSnapshot>
  checkpoint(sessionId: string): Promise<SessionSnapshot>
  status(sessionId: string): Promise<SessionSnapshot>
  acceptAll(sessionId: string): Promise<SessionSnapshot>
  discardAll(sessionId: string): Promise<SessionSnapshot>
  acceptFile(sessionId: string, path: string): Promise<SessionSnapshot>
  discardFile(sessionId: string, path: string): Promise<SessionSnapshot>
}

function toText(message: string | Buffer) {
  return typeof message === "string" ? message : new TextDecoder().decode(message)
}

export function createWebSocketSession(registry: ProviderRegistry, manager: SessionManager, send: SendMessage) {
  const active = new Map<string, ActiveEntry>()

  const sendChecked = (message: WebSocketServerMessage) => {
    send(WebSocketServerMessageSchema.parse(message))
  }

  const sendChatEvent = (id: string, event: ChatStreamEvent) => {
    sendChecked({ type: "chat_event", id, event })
  }

  const cancel = (id: string, notify = true) => {
    const entry = active.get(id)
    if (!entry) {
      return
    }
    if ("controller" in entry) {
      entry.controller.abort()
    } else {
      entry.abort()
    }
    active.delete(id)
    if (notify) {
      sendChecked({ type: "cancelled", id })
    }
  }

  const cancelSession = (id: string, sessionId: string) => {
    const entry = active.get(sessionId)
    if (entry) {
      if ("controller" in entry) {
        entry.controller.abort()
      } else {
        entry.abort()
      }
      active.delete(sessionId)
    }
    sendChecked({ type: "cancelled", id })
    sendChecked({ type: "run.status", id, sessionId, status: "done" })
  }

  const sendChanges = async (id: string, sessionId: string, snapshot?: SessionSnapshot) => {
    const current = snapshot ?? (await manager.status(sessionId))
    sendChecked({
      type: "changes.updated",
      id,
      sessionId,
      files: current.files,
      baseRef: publicRefName(current.session.baseRef),
      agentRef: publicRefName(current.session.agentRef),
    })
  }

  const getSession = (id: string, sessionId: string) => {
    const session = manager.getSession(sessionId)
    if (!session) {
      sendChecked({ type: "error", id, error: `Unknown session: ${sessionId}` })
      return undefined
    }
    return session
  }

  const createSession = async (message: Extract<WebSocketClientMessage, { type: "session.create" }>) => {
    const providerId = message.provider ?? getDefaultProviderId(registry)
    const provider = registry[providerId]
    const session = await manager.createSession({
      repoRoot: message.repoRoot,
      provider: providerId,
      model: message.model ?? provider.info.defaultModel,
    })
    sendChecked({ type: "session.created", id: message.id, session })
  }

  const openSession = (message: Extract<WebSocketClientMessage, { type: "session.open" }>) => {
    const session = getSession(message.id, message.sessionId)
    if (!session) {
      return
    }
    sendChecked({ type: "session.created", id: message.id, session })
    void sendChanges(message.id, session.id)
  }

  const streamSessionTurn = async (message: Extract<WebSocketClientMessage, { type: "chat.turn" }>) => {
    const session = getSession(message.id, message.sessionId)
    if (!session) {
      return
    }

    const userMessage = { role: "user" as const, content: message.prompt }
    const running = active.get(session.id)
    if (running) {
      if (!("queued" in running)) {
        sendChecked({ type: "error", id: message.id, error: `Session is already running: ${session.id}` })
        return
      }
      running.messages = [...running.messages, userMessage]
      running.queued.push(userMessage)
      const updatedSession = await manager.updateSessionMessages(session.id, running.messages)
      sendChecked({
        type: "user.queued",
        id: message.id,
        sessionId: session.id,
        messages: updatedSession.messages,
      })
      return
    }

    const provider = registry[session.provider]
    if (!provider.info.configured) {
      sendChecked({
        type: "error",
        id: message.id,
        error: `${provider.info.label} is not configured on the server.`,
      })
      return
    }

    const controller = new AbortController()
    const messages = [...session.messages, userMessage]
    const activeRun: ActiveRun = {
      controller,
      messages,
      queued: [],
    }
    active.set(session.id, activeRun)
    await manager.updateSessionMessages(session.id, messages)
    let assistantText = ""

    const request: ChatRequest = {
      provider: session.provider,
      model: session.model,
      stream: true,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      messages,
    }

    try {
      sendChecked({ type: "run.status", id: message.id, sessionId: session.id, status: "syncing" })
      await manager.sync(session.id)
      sendChecked({ type: "run.status", id: message.id, sessionId: session.id, status: "running" })
      const hasWorktree = Boolean(session.worktreePath)
      let summary: string | undefined
      if (hasWorktree) {
        summary = await runAgentTurn({
          provider,
          model: session.model,
          prompt: message.prompt,
          messages,
          systemPrompt: request.systemPrompt ?? AGENT_SYSTEM_PROMPT,
          repoRoot: session.repoRoot,
          worktreePath: session.worktreePath,
          signal: controller.signal,
          drainQueuedMessages() {
            const queued = activeRun.queued.splice(0)
            return queued
          },
          onDelta(text) {
            assistantText += text
            sendChecked({
              type: "assistant.delta",
              id: message.id,
              sessionId: session.id,
              text,
            })
          },
        })
      } else {
        for await (const event of provider.stream(request, controller.signal)) {
          if (event.type === "text_delta") {
            assistantText += event.text
            sendChecked({
              type: "assistant.delta",
              id: message.id,
              sessionId: session.id,
              text: event.text,
            })
          }
          if (event.type === "done") {
            summary = event.text
          }
        }
      }
      let updatedMessages = activeRun.messages
      if (assistantText.trim()) {
        updatedMessages = [...activeRun.messages, { role: "assistant", content: assistantText }]
        await manager.updateSessionMessages(session.id, updatedMessages)
      }
      sendChecked({
        type: "assistant.done",
        id: message.id,
        sessionId: session.id,
        summary,
        messages: updatedMessages,
      })
      sendChecked({
        type: "run.status",
        id: message.id,
        sessionId: session.id,
        status: "checkpointing",
      })
      const snapshot = await manager.checkpoint(session.id)
      await sendChanges(message.id, session.id, snapshot)
      sendChecked({ type: "run.status", id: message.id, sessionId: session.id, status: "done" })
    } catch (error) {
      if (!controller.signal.aborted) {
        sendChecked({
          type: "error",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (active.get(session.id) === activeRun) {
        active.delete(session.id)
      }
    }
  }

  const runInlineEdit = async (message: Extract<WebSocketClientMessage, { type: "inline.edit" }>) => {
    const request = toInlineEditChatRequest(registry, message)
    const provider = registry[request.provider]
    if (!provider.info.configured) {
      sendChecked({
        type: "error",
        id: message.id,
        error: `${provider.info.label} is not configured on the server.`,
      })
      return
    }

    const controller = new AbortController()
    active.set(message.id, controller)
    try {
      const response = await provider.complete(request, controller.signal)
      sendChecked({ type: "inline.result", id: message.id, replacementText: response.text })
    } catch (error) {
      if (!controller.signal.aborted) {
        sendChecked({
          type: "error",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (active.get(message.id) === controller) {
        active.delete(message.id)
      }
    }
  }

  const startChat = async (message: Extract<WebSocketClientMessage, { type: "chat" }>) => {
    cancel(message.id)

    await streamChat(message.id, message.request)
  }

  const startCompletion = async (message: Extract<WebSocketClientMessage, { type: "completion" }>) => {
    cancel(message.id)
    await streamChat(message.id, toCompletionChatRequest(registry, message.request))
  }

  const streamChat = async (id: string, request: ChatRequest) => {
    const provider = registry[request.provider]
    if (!provider.info.configured) {
      sendChecked({
        type: "error",
        id,
        error: `${provider.info.label} is not configured on the server.`,
      })
      return
    }

    const controller = new AbortController()
    active.set(id, controller)

    try {
      if (request.stream) {
        for await (const event of provider.stream(request, controller.signal)) {
          sendChatEvent(id, event)
        }
      } else {
        const response = await provider.complete(request, controller.signal)
        sendChatEvent(id, {
          type: "done",
          provider: response.provider,
          model: response.model,
          text: response.text,
          usage: response.usage,
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        sendChecked({
          type: "error",
          id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (active.get(id) === controller) {
        active.delete(id)
      }
    }
  }

  const handleMessage = (rawMessage: string | Buffer) => {
    let message: WebSocketClientMessage

    try {
      message = WebSocketClientMessageSchema.parse(JSON.parse(toText(rawMessage)))
    } catch (error) {
      sendChecked({
        type: "error",
        error: error instanceof Error ? error.message : "Invalid WebSocket message.",
      })
      return
    }

    switch (message.type) {
      case "session.create":
        void createSession(message).catch(error =>
          sendChecked({
            type: "error",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          })
        )
        break
      case "session.open":
        openSession(message)
        break
      case "chat.turn":
        void streamSessionTurn(message)
        break
      case "inline.edit":
        void runInlineEdit(message)
        break
      case "run.cancel":
        cancelSession(message.id, message.sessionId)
        break
      case "changes.status":
        if (getSession(message.id, message.sessionId)) {
          void sendChanges(message.id, message.sessionId).catch(error =>
            sendChecked({
              type: "error",
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            })
          )
        }
        break
      case "changes.accept_file":
        if (getSession(message.id, message.sessionId)) {
          void manager
            .acceptFile(message.sessionId, message.path)
            .then(snapshot => sendChanges(message.id, message.sessionId, snapshot))
            .catch(error =>
              sendChecked({
                type: "error",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              })
            )
        }
        break
      case "changes.discard_file":
        if (getSession(message.id, message.sessionId)) {
          void manager
            .discardFile(message.sessionId, message.path)
            .then(snapshot => sendChanges(message.id, message.sessionId, snapshot))
            .catch(error =>
              sendChecked({
                type: "error",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              })
            )
        }
        break
      case "changes.accept_all":
        if (getSession(message.id, message.sessionId)) {
          void manager
            .acceptAll(message.sessionId)
            .then(snapshot => sendChanges(message.id, message.sessionId, snapshot))
            .catch(error =>
              sendChecked({
                type: "error",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              })
            )
        }
        break
      case "changes.discard_all":
        if (getSession(message.id, message.sessionId)) {
          void manager
            .discardAll(message.sessionId)
            .then(snapshot => sendChanges(message.id, message.sessionId, snapshot))
            .catch(error =>
              sendChecked({
                type: "error",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              })
            )
        }
        break
      case "chat":
        void startChat(message)
        break
      case "completion":
        void startCompletion(message)
        break
      case "cancel":
        cancel(message.id)
        break
      case "ping":
        sendChecked({ type: "pong", id: message.id })
        break
    }
  }

  const close = () => {
    for (const entry of active.values()) {
      if ("controller" in entry) {
        entry.controller.abort()
      } else {
        entry.abort()
      }
    }
    active.clear()
  }

  return {
    open() {
      sendChecked({ type: "ready", protocolVersion: 1 })
    },
    message: handleMessage,
    close,
  }
}

export function createWebSocketHandler(
  registry: ProviderRegistry,
  manager: SessionManager = new WorktreeManager()
): WebSocketHandler<unknown> {
  const sessions = new WeakMap<ServerWebSocket<unknown>, ReturnType<typeof createWebSocketSession>>()

  const safeSend = (ws: ServerWebSocket<unknown>, message: WebSocketServerMessage) => {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // The socket can close while an upstream provider is still yielding.
    }
  }

  return {
    open(ws: ServerWebSocket<unknown>) {
      const session = createWebSocketSession(registry, manager, message => safeSend(ws, message))
      sessions.set(ws, session)
      session.open()
    },
    message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
      sessions.get(ws)?.message(message)
    },
    close(ws: ServerWebSocket<unknown>) {
      sessions.get(ws)?.close()
      sessions.delete(ws)
    },
  }
}
