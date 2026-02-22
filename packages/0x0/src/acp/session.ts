import { RequestError, type McpServer } from "@agentclientprotocol/sdk"
import type { ACPSessionState } from "./types"
import { Log } from "@/util/log"
import type { ZeroxzeroClient } from "@0x0-ai/sdk/v2"

const log = Log.create({ service: "acp-session-manager" })

export class ACPSessionManager {
  private sessions = new Map<string, ACPSessionState>()
  private sdk: ZeroxzeroClient

  constructor(sdk: ZeroxzeroClient) {
    this.sdk = sdk
  }

  tryGet(sessionId: string): ACPSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  async create(cwd: string, mcpServers: McpServer[], model?: ACPSessionState["model"]): Promise<ACPSessionState> {
    const session = await this.sdk.session
      .create(
        {
          title: `ACP Session ${crypto.randomUUID()}`,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((x) => x.data!)

    const sessionId = session.id
    const resolvedModel = model

    const state: ACPSessionState = {
      id: sessionId,
      cwd,
      mcpServers,
      createdAt: new Date(),
      model: resolvedModel,
      modes: {},
    }
    log.info("creating_session", { state })

    this.sessions.set(sessionId, state)
    return state
  }

  async load(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    model?: ACPSessionState["model"],
  ): Promise<ACPSessionState> {
    const session = await this.sdk.session
      .get(
        {
          sessionID: sessionId,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((x) => x.data!)

    const resolvedModel = model

    const state: ACPSessionState = {
      id: sessionId,
      cwd,
      mcpServers,
      createdAt: new Date(session.time.created),
      model: resolvedModel,
      modes: {},
    }
    log.info("loading_session", { state })

    this.sessions.set(sessionId, state)
    return state
  }

  get(sessionId: string): ACPSessionState {
    const session = this.sessions.get(sessionId)
    if (!session) {
      log.error("session not found", { sessionId })
      throw RequestError.invalidParams(JSON.stringify({ error: `Session not found: ${sessionId}` }))
    }
    return session
  }

  getModel(sessionId: string) {
    const session = this.get(sessionId)
    return session.model
  }

  setModel(sessionId: string, model: ACPSessionState["model"]) {
    const session = this.get(sessionId)
    session.model = model
    if (session.modeId) {
      if (!session.modes) session.modes = {}
      if (!session.modes[session.modeId]) session.modes[session.modeId] = {}
      const modeEntry = session.modes[session.modeId]
      if (modeEntry) modeEntry.model = model
    }
    this.sessions.set(sessionId, session)
    return session
  }

  getVariant(sessionId: string) {
    const session = this.get(sessionId)
    return session.variant
  }

  setVariant(sessionId: string, variant?: string) {
    const session = this.get(sessionId)
    session.variant = variant
    if (session.modeId) {
      if (!session.modes) session.modes = {}
      if (!session.modes[session.modeId]) session.modes[session.modeId] = {}
      const modeEntryV = session.modes[session.modeId]
      if (modeEntryV) modeEntryV.variant = variant
    }
    this.sessions.set(sessionId, session)
    return session
  }

  setMode(sessionId: string, modeId: string) {
    const session = this.get(sessionId)
    if (session.modeId) {
      if (!session.modes) session.modes = {}
      if (!session.modes[session.modeId]) session.modes[session.modeId] = {}
      const modeEntryM = session.modes[session.modeId]
      if (modeEntryM) {
        modeEntryM.model = session.model
        modeEntryM.variant = session.variant
      }
    }
    session.modeId = modeId
    const restored = session.modes?.[modeId]
    session.model = restored?.model
    session.variant = restored?.variant
    this.sessions.set(sessionId, session)
    return session
  }

  getModeSelection(sessionId: string, modeId: string) {
    const session = this.get(sessionId)
    return session.modes?.[modeId]
  }

  setModeSelection(
    sessionId: string,
    modeId: string,
    selection: {
      model?: ACPSessionState["model"]
      variant?: string
    },
  ) {
    const session = this.get(sessionId)
    if (!session.modes) session.modes = {}
    session.modes[modeId] = {
      model: selection.model,
      variant: selection.variant,
    }
    this.sessions.set(sessionId, session)
    return session
  }
}
