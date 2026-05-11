// JSON-RPC server: registers handlers for ACP methods, routes inbound
// messages through Transport, correlates outbound requests with their
// responses, and exposes a `notify()` for streaming session updates.

import { Session, type SessionDeps } from "./session"
import { Transport } from "./transport"
import type {
  AgentCapabilities,
  InitializeParams,
  InitializeResult,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  SessionCancelParams,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdate,
  SessionUpdateParams,
} from "./types"
import { isNotification, isRequest, isResponse } from "./types"

export interface ServerOptions {
  agentName?: string
  agentVersion?: string
  defaultModel?: string
  models?: string[]
  /** Per outbound request timeout in ms. Default 30s. (T2.4) */
  requestTimeoutMs?: number
  // Injectable for tests: returns a SessionDeps for a freshly-created session.
  makeSessionDeps?: (sessionId: string) => SessionDeps
}

export interface ServerHandle {
  send: (msg: RpcMessage) => void
  request: <T = unknown>(method: string, params: unknown) => Promise<T>
  notify: (method: string, params: unknown) => void
  handleInbound: (msg: RpcMessage) => Promise<void>
  /** Cancel and remove every active session. Called by the stdio entry on
   * graceful shutdown. (T2.6) */
  shutdownAll: () => void
}

/** Construct a Server bound to an existing Transport. The transport is
 * what reads stdin / writes stdout; the Server is purely about message
 * semantics. */
export function createServer(transport: Transport, opts: ServerOptions): ServerHandle {
  const agentInfo = {
    name: opts.agentName ?? "claude-agent-server",
    version: opts.agentVersion ?? "0.1.0",
  }
  const agentCapabilities: AgentCapabilities = {
    serverManagedRepoMap: false,
    agentMemory: false,
    customTools: [],
  }

  const sessions = new Map<string, Session>()
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30000

  // Outbound request correlation: id → resolver
  let nextId = 1
  type Pending = {
    resolve: (v: unknown) => void
    reject: (e: unknown) => void
    sessionId?: string
    timer: NodeJS.Timeout
  }
  const pending = new Map<number | string, Pending>()

  const send = (msg: RpcMessage) => transport.send(msg)

  const notify = (method: string, params: unknown) => {
    send({ jsonrpc: "2.0", method, params })
  }

  const request = <T,>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      const sessionId =
        params && typeof params === "object" && "sessionId" in params
          ? String((params as { sessionId: unknown }).sessionId)
          : undefined
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject({ code: -32001, message: `request ${method} timed out after ${requestTimeoutMs}ms` })
        }
      }, requestTimeoutMs)
      pending.set(id, {
        resolve: v => resolve(v as T),
        reject,
        sessionId,
        timer,
      })
      send({ jsonrpc: "2.0", id, method, params })
    })

  const rejectPendingForSession = (sessionId: string) => {
    for (const [id, p] of pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer)
        pending.delete(id)
        p.reject({ code: -32001, message: "session cancelled" })
      }
    }
  }

  const closeSession = (sessionId: string) => {
    const s = sessions.get(sessionId)
    if (s) {
      s.cancel()
      sessions.delete(sessionId)
    }
    rejectPendingForSession(sessionId)
  }

  const shutdownAll = () => {
    for (const sessionId of [...sessions.keys()]) {
      closeSession(sessionId)
    }
  }

  const respond = (id: number | string, result: unknown) => {
    send({ jsonrpc: "2.0", id, result })
  }

  const respondError = (id: number | string, code: number, message: string) => {
    send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  const emitSessionUpdate = (sessionId: string, update: SessionUpdate) => {
    const params: SessionUpdateParams = { sessionId, update }
    notify("session/update", params)
  }

  const makeDeps =
    opts.makeSessionDeps ??
    ((sessionId: string): SessionDeps => ({
      sessionId,
      notify: update => emitSessionUpdate(sessionId, update),
      request: <T,>(method: string, params: unknown) => request<T>(method, params),
    }))

  const handleInitialize = async (params: InitializeParams): Promise<InitializeResult> => {
    return {
      protocolVersion: params.protocolVersion ?? "2025-01",
      agentInfo,
      agentCapabilities,
    }
  }

  const handleSessionNew = async (params: SessionNewParams): Promise<SessionNewResult> => {
    const sessionId = `cas-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
    const deps = makeDeps(sessionId)
    const session = new Session(sessionId, params.cwd, deps, {
      defaultModel: opts.defaultModel ?? "claude-sonnet-4-6",
      models: opts.models ?? ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
    })
    sessions.set(sessionId, session)
    return { sessionId, configOptions: session.configOptions() }
  }

  const handleSessionPrompt = async (params: SessionPromptParams): Promise<SessionPromptResult> => {
    const session = sessions.get(params.sessionId)
    if (!session) {
      throw new Error("unknown sessionId: " + params.sessionId)
    }
    const stopReason = await session.prompt(params.prompt)
    return { stopReason }
  }

  const handleSessionCancel = (params: SessionCancelParams) => {
    const session = sessions.get(params.sessionId)
    if (session) {
      session.cancel()
      // Also free pending fs/* requests tied to this session (T2.4).
      rejectPendingForSession(params.sessionId)
    }
  }

  const handleSessionClose = (params: SessionCancelParams) => {
    // T2.5: explicit close that drops the session from the map.
    closeSession(params.sessionId)
  }

  const handleSessionSetModel = async (params: { sessionId: string; modelId: string }) => {
    const session = sessions.get(params.sessionId)
    if (!session) {
      throw new Error("unknown sessionId: " + params.sessionId)
    }
    session.setModel(params.modelId)
    return { configOptions: session.configOptions() }
  }

  const handleSessionSetConfigOption = async (params: {
    sessionId: string
    configId: string
    value: string
  }) => {
    const session = sessions.get(params.sessionId)
    if (!session) {
      throw new Error("unknown sessionId: " + params.sessionId)
    }
    if (params.configId === "model") {
      session.setModel(params.value)
    } else if (params.configId === "mode") {
      session.setMode(params.value)
    }
    return { configOptions: session.configOptions() }
  }

  type Handler = (params: unknown) => Promise<unknown> | unknown
  const handlers: Record<string, Handler> = {
    initialize: p => handleInitialize(p as InitializeParams),
    "session/new": p => handleSessionNew(p as SessionNewParams),
    "session/prompt": p => handleSessionPrompt(p as SessionPromptParams),
    "session/set_model": p => handleSessionSetModel(p as { sessionId: string; modelId: string }),
    "session/set_config_option": p =>
      handleSessionSetConfigOption(p as { sessionId: string; configId: string; value: string }),
  }

  const notificationHandlers: Record<string, (p: unknown) => void> = {
    "session/cancel": p => handleSessionCancel(p as SessionCancelParams),
    "session/close": p => handleSessionClose(p as SessionCancelParams),
  }

  const handleInbound = async (msg: RpcMessage): Promise<void> => {
    if (isResponse(msg)) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        p.reject(msg.error)
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (isNotification(msg)) {
      const h = notificationHandlers[msg.method]
      if (h) {
        try {
          h(msg.params)
        } catch {
          // Notifications can't surface errors.
        }
      }
      return
    }
    if (isRequest(msg)) {
      const req = msg as RpcRequest
      const h = handlers[req.method]
      if (!h) {
        respondError(req.id, -32601, "method not found: " + req.method)
        return
      }
      try {
        const result = await h(req.params)
        respond(req.id, result)
      } catch (e) {
        const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)
        respondError(req.id, -32000, message)
      }
    }
  }

  transport.onMessage(msg => {
    void handleInbound(msg)
  })

  return { send, request, notify, handleInbound, shutdownAll }
}
