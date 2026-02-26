import {
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthMethod,
  type CancelNotification,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PermissionOption,
  type PlanEntry,
  type PromptRequest,
  RequestError,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type Role,
  type SessionInfo,
  type SetSessionModelRequest,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ToolCallContent,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk"
import { LoadAPIKeyError } from "ai"
import { pathToFileURL } from "bun"
import { applyPatch } from "diff"
import { z } from "zod"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import type { Client } from "@/server/client"
import type { AssistantMessage, Event, SessionMessageResponse } from "@/server/types"
import { Todo } from "@/session/todo"
import { Agent as AgentModule } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"
import { ACPSessionManager } from "./session"
import type { ACPConfig } from "./types"

type ModeOption = { id: string; name: string; description?: string }
type ModelOption = { modelId: string; name: string }

const DEFAULT_VARIANT_VALUE = "default"

export namespace ACP {
  const log = Log.create({ service: "acp-agent" })

  async function getContextLimit(
    sdk: Client,
    providerID: string,
    modelID: string,
    directory: string
  ): Promise<number | null> {
    const providers = await sdk.provider
      .$get({ query: { directory } } as any)
      .then((r: any) => r.json())
      .then((data: any) => (data?.providers ?? []) as Provider.Info[])
      .catch(error => {
        log.error("failed to get providers for context limit", { error })
        return [] as Provider.Info[]
      })

    const provider = providers.find((p: any) => p.id === providerID)
    const model = provider?.models[modelID]
    return model?.limit.context ?? null
  }

  async function sendUsageUpdate(
    connection: AgentSideConnection,
    sdk: Client,
    sessionID: string,
    directory: string
  ): Promise<void> {
    const messages = await sdk.session[":sessionID"].message
      .$get({ param: { sessionID }, query: { directory } } as any)
      .then((r: any) => r.json())
      .catch(error => {
        log.error("failed to fetch messages for usage update", { error })
        return undefined
      })

    if (!messages) return

    const assistantMessages = messages.filter(
      (m: any): m is { info: AssistantMessage; parts: SessionMessageResponse["parts"] } => m.info.role === "assistant"
    )

    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    if (!lastAssistant) return

    const msg = lastAssistant.info
    const size = await getContextLimit(sdk, msg.providerID, msg.modelID, directory)

    if (!size) {
      // Cannot calculate usage without known context size
      return
    }

    const used = msg.tokens.input + (msg.tokens.cache?.read ?? 0)
    const totalCost = assistantMessages.reduce((sum: number, m: any) => sum + m.info.cost, 0)

    await connection
      .sessionUpdate({
        sessionId: sessionID,
        update: {
          sessionUpdate: "usage_update",
          used,
          size,
          cost: { amount: totalCost, currency: "USD" },
        },
      })
      .catch(error => {
        log.error("failed to send usage update", { error })
      })
  }

  export async function init({ sdk: _sdk }: { sdk: Client }) {
    return {
      create: (connection: AgentSideConnection, fullConfig: ACPConfig) => {
        return new Agent(connection, fullConfig)
      },
    }
  }

  async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              yield JSON.parse(line.slice(6))
            } catch {}
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  export class Agent implements ACPAgent {
    private connection: AgentSideConnection
    private config: ACPConfig
    private sdk: Client
    private sessionManager: ACPSessionManager
    private eventAbort = new AbortController()
    private eventStarted = false
    private permissionQueues = new Map<string, Promise<void>>()
    private permissionOptions: PermissionOption[] = [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ]

    constructor(connection: AgentSideConnection, config: ACPConfig) {
      this.connection = connection
      this.config = config
      this.sdk = config.sdk
      this.sessionManager = new ACPSessionManager(this.sdk)
      this.startEventSubscription()
    }

    private startEventSubscription() {
      if (this.eventStarted) return
      this.eventStarted = true
      this.runEventSubscription().catch(error => {
        if (this.eventAbort.signal.aborted) return
        log.error("event subscription failed", { error })
      })
    }

    private async runEventSubscription() {
      while (true) {
        if (this.eventAbort.signal.aborted) return
        const url = this.config.baseUrl ? new URL("/global/event", this.config.baseUrl).href : "/global/event"
        const res = await fetch(url, {
          signal: this.eventAbort.signal,
          headers: { Accept: "text/event-stream" },
        })
        if (!res.body) return
        for await (const envelope of parseSSE(res.body)) {
          if (this.eventAbort.signal.aborted) return
          const event = envelope?.payload as Event | undefined
          if (!event) continue
          await this.handleEvent(event).catch(error => {
            log.error("failed to handle event", { error, type: event?.type })
          })
        }
      }
    }

    private async handleEvent(event: Event) {
      switch (event.type) {
        case "permission.asked": {
          const permission = event.properties
          const session = this.sessionManager.tryGet(permission.sessionID)
          if (!session) return

          const prev = this.permissionQueues.get(permission.sessionID) ?? Promise.resolve()
          const next = prev
            .then(async () => {
              const directory = session.cwd

              const res = await this.connection
                .requestPermission({
                  sessionId: permission.sessionID,
                  toolCall: {
                    toolCallId: permission.tool?.callID ?? permission.id,
                    status: "pending",
                    title: permission.permission,
                    rawInput: permission.metadata,
                    kind: toToolKind(permission.permission, permission.metadata),
                    locations: toLocations(permission.permission, permission.metadata),
                  },
                  options: this.permissionOptions,
                })
                .catch(async error => {
                  log.error("failed to request permission from ACP", {
                    error,
                    permissionID: permission.id,
                    sessionID: permission.sessionID,
                  })
                  await this.sdk.permission[":requestID"].reply.$post({
                    param: { requestID: permission.id },
                    json: { reply: "reject" },
                    query: { directory },
                  } as any)
                  return undefined
                })

              if (!res) return
              if (res.outcome.outcome !== "selected") {
                await this.sdk.permission[":requestID"].reply.$post({
                  param: { requestID: permission.id },
                  json: { reply: "reject" },
                  query: { directory },
                } as any)
                return
              }

              if (res.outcome.optionId !== "reject" && permission.permission == "edit") {
                const metadata = permission.metadata || {}
                const filepath = typeof metadata["filepath"] === "string" ? metadata["filepath"] : ""
                const diff = typeof metadata["diff"] === "string" ? metadata["diff"] : ""

                const content = await Bun.file(filepath).text()
                const newContent = getNewContent(content, diff)

                if (newContent) {
                  this.connection.writeTextFile({
                    sessionId: session.id,
                    path: filepath,
                    content: newContent,
                  })
                }
              }

              await this.sdk.permission[":requestID"].reply.$post({
                param: { requestID: permission.id },
                json: { reply: res.outcome.optionId as "once" | "always" | "reject" },
                query: { directory },
              } as any)
            })
            .catch(error => {
              log.error("failed to handle permission", { error, permissionID: permission.id })
            })
            .finally(() => {
              if (this.permissionQueues.get(permission.sessionID) === next) {
                this.permissionQueues.delete(permission.sessionID)
              }
            })
          this.permissionQueues.set(permission.sessionID, next)
          return
        }

        case "message.part.updated": {
          log.info("message part updated", { event: event.properties })
          const props = event.properties
          const part = props.part
          const session = this.sessionManager.tryGet(part.sessionID)
          if (!session) return
          const sessionId = session.id
          const directory = session.cwd

          const message = await this.sdk.session[":sessionID"].message[":messageID"]
            .$get({
              param: { sessionID: part.sessionID, messageID: part.messageID },
              query: { directory },
            } as any)
            .then((r: any) => r.json())
            .catch(error => {
              log.error("unexpected error when fetching message", { error })
              return undefined
            })

          if (!message || message.info.role !== "assistant") return

          if (part.type === "tool") {
            switch (part.state.status) {
              case "pending":
                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call",
                      toolCallId: part.callID,
                      title: part.tool,
                      kind: toToolKind(part.tool, part.state.input),
                      status: "pending",
                      locations: [],
                      rawInput: {},
                    },
                  })
                  .catch(error => {
                    log.error("failed to send tool pending to ACP", { error })
                  })
                return

              case "running":
                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "in_progress",
                      kind: toToolKind(part.tool, part.state.input),
                      title: part.tool,
                      locations: toLocations(part.tool, part.state.input),
                      rawInput: part.state.input,
                    },
                  })
                  .catch(error => {
                    log.error("failed to send tool in_progress to ACP", { error })
                  })
                return

              case "completed": {
                const kind = toToolKind(part.tool, part.state.input)
                const content: ToolCallContent[] = [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: part.state.output,
                    },
                  },
                ]

                if (kind === "edit") {
                  content.push(...editDiffContent(part.tool, part.state.input, part.state.metadata))
                }

                if (part.tool === "todowrite") {
                  const parsedTodos = z.array(Todo.Info).safeParse(JSON.parse(part.state.output))
                  if (parsedTodos.success) {
                    await this.connection
                      .sessionUpdate({
                        sessionId,
                        update: {
                          sessionUpdate: "plan",
                          entries: parsedTodos.data.map(todo => {
                            const status: PlanEntry["status"] =
                              todo.status === "cancelled" ? "completed" : (todo.status as PlanEntry["status"])
                            return {
                              priority: "medium",
                              status,
                              content: todo.content,
                            }
                          }),
                        },
                      })
                      .catch(error => {
                        log.error("failed to send session update for todo", { error })
                      })
                  } else {
                    log.error("failed to parse todo output", { error: parsedTodos.error })
                  }
                }

                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "completed",
                      kind,
                      content,
                      title: part.state.title,
                      rawInput: part.state.input,
                      rawOutput: {
                        output: part.state.output,
                        metadata: part.state.metadata,
                      },
                    },
                  })
                  .catch(error => {
                    log.error("failed to send tool completed to ACP", { error })
                  })
                return
              }
              case "error":
                await this.connection
                  .sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: part.callID,
                      status: "failed",
                      kind: toToolKind(part.tool, part.state.input),
                      title: part.tool,
                      rawInput: part.state.input,
                      content: [
                        {
                          type: "content",
                          content: {
                            type: "text",
                            text: part.state.error,
                          },
                        },
                      ],
                      rawOutput: {
                        error: part.state.error,
                      },
                    },
                  })
                  .catch(error => {
                    log.error("failed to send tool error to ACP", { error })
                  })
                return
            }
          }

          if (part.type === "text") {
            const delta = props.delta
            if (delta && part.ignored !== true) {
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: delta,
                    },
                  },
                })
                .catch(error => {
                  log.error("failed to send text to ACP", { error })
                })
            }
            return
          }

          if (part.type === "reasoning") {
            const delta = props.delta
            if (delta) {
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                      type: "text",
                      text: delta,
                    },
                  },
                })
                .catch(error => {
                  log.error("failed to send reasoning to ACP", { error })
                })
            }
          }
          return
        }
      }
    }

    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      log.info("initialize", { protocolVersion: params.protocolVersion })

      const authMethod: AuthMethod = {
        description: "Run `zeroxzero auth login` in the terminal",
        name: "Login with zeroxzero",
        id: "zeroxzero-login",
      }

      // If client supports terminal-auth capability, use that instead.
      if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
        authMethod._meta = {
          "terminal-auth": {
            command: "zeroxzero",
            args: ["auth", "login"],
            label: "zeroxzero Login",
          },
        }
      }

      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: true,
            sse: true,
          },
          promptCapabilities: {
            embeddedContext: true,
            image: true,
          },
          sessionCapabilities: {
            fork: {},
            list: {},
            resume: {},
          },
        },
        authMethods: [authMethod],
        agentInfo: {
          name: "zeroxzero",
          version: Installation.VERSION,
        },
      }
    }

    async authenticate(_params: AuthenticateRequest) {
      throw new Error("Authentication not implemented")
    }

    async newSession(params: NewSessionRequest) {
      const directory = params.cwd
      try {
        const model = await defaultModel(this.config, directory)

        // Store ACP session state
        const state = await this.sessionManager.create(params.cwd, params.mcpServers, model)
        const sessionId = state.id

        log.info("creating_session", { sessionId, mcpServers: params.mcpServers.length })

        const load = await this.loadSessionMode({
          cwd: directory,
          mcpServers: params.mcpServers,
          sessionId,
        })

        return {
          sessionId,
          models: load.models,
          modes: load.modes,
          _meta: load._meta,
        }
      } catch (e) {
        if (LoadAPIKeyError.isInstance(e)) {
          throw RequestError.authRequired()
        }
        throw e
      }
    }

    async loadSession(params: LoadSessionRequest) {
      const directory = params.cwd
      const sessionId = params.sessionId

      try {
        const model = await defaultModel(this.config, directory)

        // Store ACP session state
        await this.sessionManager.load(sessionId, params.cwd, params.mcpServers, model)

        log.info("load_session", { sessionId, mcpServers: params.mcpServers.length })

        const result = await this.loadSessionMode({
          cwd: directory,
          mcpServers: params.mcpServers,
          sessionId,
        })

        // Replay session history
        const messages = await this.sdk.session[":sessionID"].message
          .$get({
            param: { sessionID: sessionId },
            query: { directory },
          } as any)
          .then((r: any) => r.json())
          .catch(err => {
            log.error("unexpected error when fetching message", { error: err })
            return undefined
          })

        const lastUser = messages?.findLast((m: any) => m.info.role === "user")?.info
        if (lastUser?.role === "user") {
          if (result.modes?.availableModes.some(m => m.id === lastUser.agent)) {
            result.modes.currentModeId = lastUser.agent
            this.sessionManager.setMode(sessionId, lastUser.agent)
          }
          const model = {
            providerID: lastUser.model.providerID,
            modelID: lastUser.model.modelID,
          }
          this.sessionManager.setModel(sessionId, model)
          this.sessionManager.setVariant(sessionId, lastUser.variant)

          const providers = await this.sdk.provider
            .$get({ query: { directory } } as any)
            .then((r: any) => r.json())
            .then((data: any) => data.providers as Provider.Info[])
          const entries = sortProvidersByName(providers)
          const availableVariants = modelVariantsFromProviders(entries, model)
          result.models.currentModelId = formatModelIdWithVariant(model, lastUser.variant, availableVariants, true)
        }

        for (const msg of messages ?? []) {
          log.debug("replay message", msg)
          await this.processMessage(msg)
        }

        await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

        return result
      } catch (e) {
        if (LoadAPIKeyError.isInstance(e)) {
          throw RequestError.authRequired()
        }
        throw e
      }
    }

    async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
      try {
        const cursor = params.cursor ? Number(params.cursor) : undefined
        const limit = 100

        const sessions = await this.sdk.session
          .$get({ query: { directory: params.cwd ?? undefined, roots: "true" } } as any)
          .then((r: any) => r.json())

        const sorted = sessions.toSorted((a: any, b: any) => b.time.updated - a.time.updated)
        const filtered = cursor ? sorted.filter((s: any) => s.time.updated < cursor) : sorted
        const page = filtered.slice(0, limit)

        const entries: SessionInfo[] = page.map((session: any) => ({
          sessionId: session.id,
          cwd: session.directory,
          title: session.title,
          updatedAt: new Date(session.time.updated).toISOString(),
        }))

        const last = page[page.length - 1]
        const next = filtered.length > limit && last ? String(last.time.updated) : undefined

        const response: ListSessionsResponse = {
          sessions: entries,
        }
        if (next) response.nextCursor = next
        return response
      } catch (e) {
        if (LoadAPIKeyError.isInstance(e)) {
          throw RequestError.authRequired()
        }
        throw e
      }
    }

    async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
      const directory = params.cwd
      const mcpServers = params.mcpServers ?? []

      try {
        const model = await defaultModel(this.config, directory)

        const forked = await this.sdk.session[":sessionID"].fork
          .$post({
            param: { sessionID: params.sessionId },
            json: {},
            query: { directory },
          } as any)
          .then((r: any) => r.json())

        if (!forked) {
          throw new Error("Fork session returned no data")
        }

        const sessionId = forked.id
        await this.sessionManager.load(sessionId, directory, mcpServers, model)

        log.info("fork_session", { sessionId, mcpServers: mcpServers.length })

        const mode = await this.loadSessionMode({
          cwd: directory,
          mcpServers,
          sessionId,
        })

        const messages = await this.sdk.session[":sessionID"].message
          .$get({
            param: { sessionID: sessionId },
            query: { directory },
          } as any)
          .then((r: any) => r.json())
          .catch(err => {
            log.error("unexpected error when fetching message", { error: err })
            return undefined
          })

        for (const msg of messages ?? []) {
          log.debug("replay message", msg)
          await this.processMessage(msg)
        }

        await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

        return mode
      } catch (e) {
        if (LoadAPIKeyError.isInstance(e)) {
          throw RequestError.authRequired()
        }
        throw e
      }
    }

    async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
      const directory = params.cwd
      const sessionId = params.sessionId
      const mcpServers = params.mcpServers ?? []

      try {
        const model = await defaultModel(this.config, directory)
        await this.sessionManager.load(sessionId, directory, mcpServers, model)

        log.info("resume_session", { sessionId, mcpServers: mcpServers.length })

        const result = await this.loadSessionMode({
          cwd: directory,
          mcpServers,
          sessionId,
        })

        await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)

        return result
      } catch (e) {
        if (LoadAPIKeyError.isInstance(e)) {
          throw RequestError.authRequired()
        }
        throw e
      }
    }

    private async processMessage(message: SessionMessageResponse) {
      log.debug("process message", message)
      if (message.info.role !== "assistant" && message.info.role !== "user") return
      const sessionId = message.info.sessionID

      for (const part of message.parts) {
        if (part.type === "tool") {
          switch (part.state.status) {
            case "pending":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: part.callID,
                    title: part.tool,
                    kind: toToolKind(part.tool, part.state.input),
                    status: "pending",
                    locations: [],
                    rawInput: {},
                  },
                })
                .catch(err => {
                  log.error("failed to send tool pending to ACP", { error: err })
                })
              break
            case "running":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "in_progress",
                    kind: toToolKind(part.tool, part.state.input),
                    title: part.tool,
                    locations: toLocations(part.tool, part.state.input),
                    rawInput: part.state.input,
                  },
                })
                .catch(err => {
                  log.error("failed to send tool in_progress to ACP", { error: err })
                })
              break
            case "completed":
              const kind = toToolKind(part.tool, part.state.input)
              const content: ToolCallContent[] = [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: part.state.output,
                  },
                },
              ]

              if (kind === "edit") {
                content.push(...editDiffContent(part.tool, part.state.input, part.state.metadata))
              }

              if (part.tool === "todowrite") {
                const parsedTodos = z.array(Todo.Info).safeParse(JSON.parse(part.state.output))
                if (parsedTodos.success) {
                  await this.connection
                    .sessionUpdate({
                      sessionId,
                      update: {
                        sessionUpdate: "plan",
                        entries: parsedTodos.data.map(todo => {
                          const status: PlanEntry["status"] =
                            todo.status === "cancelled" ? "completed" : (todo.status as PlanEntry["status"])
                          return {
                            priority: "medium",
                            status,
                            content: todo.content,
                          }
                        }),
                      },
                    })
                    .catch(err => {
                      log.error("failed to send session update for todo", { error: err })
                    })
                } else {
                  log.error("failed to parse todo output", { error: parsedTodos.error })
                }
              }

              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "completed",
                    kind,
                    content,
                    title: part.state.title,
                    rawInput: part.state.input,
                    rawOutput: {
                      output: part.state.output,
                      metadata: part.state.metadata,
                    },
                  },
                })
                .catch(err => {
                  log.error("failed to send tool completed to ACP", { error: err })
                })
              break
            case "error":
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: part.callID,
                    status: "failed",
                    kind: toToolKind(part.tool, part.state.input),
                    title: part.tool,
                    rawInput: part.state.input,
                    content: [
                      {
                        type: "content",
                        content: {
                          type: "text",
                          text: part.state.error,
                        },
                      },
                    ],
                    rawOutput: {
                      error: part.state.error,
                    },
                  },
                })
                .catch(err => {
                  log.error("failed to send tool error to ACP", { error: err })
                })
              break
          }
        } else if (part.type === "text") {
          if (part.text) {
            const audience: Role[] | undefined = part.synthetic ? ["assistant"] : part.ignored ? ["user"] : undefined
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: message.info.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                  content: {
                    type: "text",
                    text: part.text,
                    ...(audience && { annotations: { audience } }),
                  },
                },
              })
              .catch(err => {
                log.error("failed to send text to ACP", { error: err })
              })
          }
        } else if (part.type === "file") {
          // Replay file attachments as appropriate ACP content blocks.
          // zeroxzero stores files internally as { type: "file", url, filename, mime }.
          // We convert these back to ACP blocks based on the URL scheme and MIME type:
          // - file:// URLs → resource_link
          // - data: URLs with image/* → image block
          // - data: URLs with text/* or application/json → resource with text
          // - data: URLs with other types → resource with blob
          const url = part.url
          const filename = part.filename ?? "file"
          const mime = part.mime || "application/octet-stream"
          const messageChunk = message.info.role === "user" ? "user_message_chunk" : "agent_message_chunk"

          if (url.startsWith("file://")) {
            // Local file reference - send as resource_link
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: messageChunk,
                  content: { type: "resource_link", uri: url, name: filename, mimeType: mime },
                },
              })
              .catch(err => {
                log.error("failed to send resource_link to ACP", { error: err })
              })
          } else if (url.startsWith("data:")) {
            // Embedded content - parse data URL and send as appropriate block type
            const base64Match = url.match(/^data:([^;]+);base64,(.*)$/)
            const dataMime = base64Match?.[1]
            const base64Data = base64Match?.[2] ?? ""

            const effectiveMime = dataMime || mime

            if (effectiveMime.startsWith("image/")) {
              // Image - send as image block
              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: messageChunk,
                    content: {
                      type: "image",
                      mimeType: effectiveMime,
                      data: base64Data,
                      uri: pathToFileURL(filename).href,
                    },
                  },
                })
                .catch(err => {
                  log.error("failed to send image to ACP", { error: err })
                })
            } else {
              // Non-image: text types get decoded, binary types stay as blob
              const isText = effectiveMime.startsWith("text/") || effectiveMime === "application/json"
              const fileUri = pathToFileURL(filename).href
              const resource = isText
                ? {
                    uri: fileUri,
                    mimeType: effectiveMime,
                    text: Buffer.from(base64Data, "base64").toString("utf-8"),
                  }
                : { uri: fileUri, mimeType: effectiveMime, blob: base64Data }

              await this.connection
                .sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: messageChunk,
                    content: { type: "resource", resource },
                  },
                })
                .catch(err => {
                  log.error("failed to send resource to ACP", { error: err })
                })
            }
          }
          // URLs that don't match file:// or data: are skipped (unsupported)
        } else if (part.type === "reasoning") {
          if (part.text) {
            await this.connection
              .sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: {
                    type: "text",
                    text: part.text,
                  },
                },
              })
              .catch(err => {
                log.error("failed to send reasoning to ACP", { error: err })
              })
          }
        }
      }
    }

    private async loadAvailableModes(directory: string): Promise<ModeOption[]> {
      const agents = await this.config.sdk.agent.$get({ query: { directory } } as any).then((r: any) => r.json())

      return agents
        .filter((agent: any) => !agent.hidden)
        .map((agent: any) => ({
          id: agent.name,
          name: agent.name,
          description: agent.description,
        }))
    }

    private async resolveModeState(
      directory: string,
      sessionId: string
    ): Promise<{ availableModes: ModeOption[]; currentModeId?: string }> {
      const availableModes = await this.loadAvailableModes(directory)
      const currentModeId =
        this.sessionManager.get(sessionId).modeId ||
        (await (async () => {
          if (!availableModes.length) return undefined
          const first = availableModes[0]
          if (!first) return undefined
          const defaultAgentName = await AgentModule.defaultAgent()
          const resolvedModeId = availableModes.find(mode => mode.name === defaultAgentName)?.id ?? first.id
          this.sessionManager.setMode(sessionId, resolvedModeId)
          return resolvedModeId
        })())

      return { availableModes, currentModeId }
    }

    private async loadSessionMode(params: LoadSessionRequest) {
      const directory = params.cwd
      const sessionId = params.sessionId
      const modeState = await this.resolveModeState(directory, sessionId)
      const currentModeId = modeState.currentModeId
      const modeAgent = currentModeId ? await AgentModule.get(currentModeId) : undefined

      const fallbackModel = await defaultModel(this.config, directory)
      const sessionModel = this.sessionManager.getModel(sessionId)
      let model = sessionModel ?? modeAgent?.model ?? fallbackModel
      if (!sessionModel) {
        this.sessionManager.setModel(sessionId, model)
      }

      const sessionVariant = this.sessionManager.getVariant(sessionId)
      const modeVariant =
        modeAgent?.variant &&
        modeAgent.model?.providerID === model.providerID &&
        modeAgent.model.modelID === model.modelID
          ? modeAgent.variant
          : undefined
      if (sessionVariant === undefined && modeVariant !== undefined) {
        this.sessionManager.setVariant(sessionId, modeVariant)
      }

      const providers = await this.sdk.provider
        .$get({ query: { directory } } as any)
        .then((r: any) => r.json())
        .then((data: any) => data.providers as Provider.Info[])
      const entries = sortProvidersByName(providers)
      const hasModel = entries.some(entry => entry.id === model.providerID && !!entry.models[model.modelID])
      if (!hasModel) {
        model = fallbackModel
        this.sessionManager.setModel(sessionId, model)
      }
      const availableVariants = modelVariantsFromProviders(entries, model)
      const currentVariant = this.sessionManager.getVariant(sessionId)
      if (currentVariant && !availableVariants.includes(currentVariant)) {
        this.sessionManager.setVariant(sessionId, undefined)
      }
      const variant = this.sessionManager.getVariant(sessionId)
      const availableModels = buildAvailableModels(entries, { includeVariants: true })
      const modes = currentModeId
        ? {
            availableModes: modeState.availableModes,
            currentModeId,
          }
        : undefined

      const commands = await this.config.sdk.command.$get({ query: { directory } } as any).then((r: any) => r.json())

      const availableCommands = commands.map((command: any) => ({
        name: command.name,
        description: command.description ?? "",
      }))
      const names = new Set(availableCommands.map((c: any) => c.name))
      if (!names.has("compact"))
        availableCommands.push({
          name: "compact",
          description: "compact the session",
        })

      const mcpServers: Record<string, Config.Mcp> = {}
      for (const server of params.mcpServers) {
        if ("type" in server) {
          mcpServers[server.name] = {
            url: server.url,
            headers: server.headers.reduce<Record<string, string>>((acc, { name, value }) => {
              acc[name] = value
              return acc
            }, {}),
            type: "remote",
          }
        } else {
          mcpServers[server.name] = {
            type: "local",
            command: [server.command, ...server.args],
            environment: server.env.reduce<Record<string, string>>((acc, { name, value }) => {
              acc[name] = value
              return acc
            }, {}),
          }
        }
      }

      await Promise.all(
        Object.entries(mcpServers).map(async ([key, mcp]) => {
          await this.sdk.mcp.$post({ json: { name: key, config: mcp }, query: { directory } } as any).catch(error => {
            log.error("failed to add mcp server", { name: key, error })
          })
        })
      )

      setTimeout(() => {
        this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands,
          },
        })
      }, 0)

      return {
        sessionId,
        models: {
          currentModelId: formatModelIdWithVariant(model, variant, availableVariants, true),
          availableModels,
        },
        modes,
        _meta: buildVariantMeta({
          model,
          variant,
          availableVariants,
        }),
      }
    }

    async unstable_setSessionModel(params: SetSessionModelRequest) {
      const session = this.sessionManager.get(params.sessionId)
      const providers = await this.sdk.provider
        .$get({ query: { directory: session.cwd } } as any)
        .then((r: any) => r.json())
        .then((data: any) => data.providers as Provider.Info[])

      const selection = parseModelSelection(params.modelId, providers)
      this.sessionManager.setModel(session.id, selection.model)
      this.sessionManager.setVariant(session.id, selection.variant)

      const entries = sortProvidersByName(providers)
      const availableVariants = modelVariantsFromProviders(entries, selection.model)

      return {
        _meta: buildVariantMeta({
          model: selection.model,
          variant: selection.variant,
          availableVariants,
        }),
      }
    }

    async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
      const session = this.sessionManager.get(params.sessionId)
      const availableModes = await this.loadAvailableModes(session.cwd)
      if (!availableModes.some(mode => mode.id === params.modeId)) {
        throw new Error(`Agent not found: ${params.modeId}`)
      }
      this.sessionManager.setMode(params.sessionId, params.modeId)

      const current = this.sessionManager.get(params.sessionId)
      const modeAgent = await AgentModule.get(params.modeId)
      const fallbackModel = await defaultModel(this.config, session.cwd)
      const model = current.model ?? modeAgent?.model ?? fallbackModel
      this.sessionManager.setModel(params.sessionId, model)

      const availableProviders = await this.sdk.provider
        .$get({ query: { directory: session.cwd } } as any)
        .then((r: any) => r.json())
        .then((data: any) => data.providers as Provider.Info[])
      const availableVariants = modelVariantsFromProviders(sortProvidersByName(availableProviders), model)
      const configuredVariant =
        modeAgent?.variant &&
        modeAgent.model?.providerID === model.providerID &&
        modeAgent.model.modelID === model.modelID
          ? modeAgent.variant
          : undefined
      const variant = current.variant ?? configuredVariant
      this.sessionManager.setVariant(
        params.sessionId,
        variant && availableVariants.includes(variant) ? variant : undefined
      )
    }

    async prompt(params: PromptRequest) {
      const sessionID = params.sessionId
      const session = this.sessionManager.get(sessionID)
      const directory = session.cwd

      const agent = session.modeId ?? (await AgentModule.defaultAgent())
      const modeAgent = await AgentModule.get(agent)
      const current = session.model
      const model = current ?? modeAgent?.model ?? (await defaultModel(this.config, directory))
      if (!current) {
        this.sessionManager.setModel(session.id, model)
      }
      const storedVariant = this.sessionManager.getVariant(sessionID)
      const configuredVariant =
        modeAgent?.variant &&
        modeAgent.model?.providerID === model.providerID &&
        modeAgent.model.modelID === model.modelID
          ? modeAgent.variant
          : undefined
      const variant = storedVariant ?? configuredVariant
      if (storedVariant === undefined && configuredVariant !== undefined) {
        this.sessionManager.setVariant(sessionID, configuredVariant)
      }

      const parts: Array<
        | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
        | { type: "file"; url: string; filename: string; mime: string }
      > = []
      for (const part of params.prompt) {
        switch (part.type) {
          case "text":
            const audience = part.annotations?.audience
            const forAssistant = audience?.length === 1 && audience[0] === "assistant"
            const forUser = audience?.length === 1 && audience[0] === "user"
            parts.push({
              type: "text" as const,
              text: part.text,
              ...(forAssistant && { synthetic: true }),
              ...(forUser && { ignored: true }),
            })
            break
          case "image": {
            const parsed = parseUri(part.uri ?? "")
            const filename = parsed.type === "file" ? parsed.filename : "image"
            if (part.data) {
              parts.push({
                type: "file",
                url: `data:${part.mimeType};base64,${part.data}`,
                filename,
                mime: part.mimeType,
              })
            } else if (part.uri && part.uri.startsWith("http:")) {
              parts.push({
                type: "file",
                url: part.uri,
                filename,
                mime: part.mimeType,
              })
            }
            break
          }

          case "resource_link":
            const parsed = parseUri(part.uri)
            // Use the name from resource_link if available
            if (part.name && parsed.type === "file") {
              parsed.filename = part.name
            }
            parts.push(parsed)

            break

          case "resource": {
            const resource = part.resource
            if ("text" in resource && resource.text) {
              parts.push({
                type: "text",
                text: resource.text,
              })
            } else if ("blob" in resource && resource.blob && resource.mimeType) {
              // Binary resource (PDFs, etc.): store as file part with data URL
              const parsed = parseUri(resource.uri ?? "")
              const filename = parsed.type === "file" ? parsed.filename : "file"
              parts.push({
                type: "file",
                url: `data:${resource.mimeType};base64,${resource.blob}`,
                filename,
                mime: resource.mimeType,
              })
            }
            break
          }

          default:
            break
        }
      }

      log.info("parts", { parts })

      const cmd = (() => {
        const text = parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map(p => p.text)
          .join("")
          .trim()

        if (!text.startsWith("/")) return

        const [name, ...rest] = text.slice(1).split(/\s+/)
        return { name, args: rest.join(" ").trim() }
      })()

      const buildUsage = (msg: AssistantMessage): Usage => ({
        totalTokens:
          msg.tokens.input +
          msg.tokens.output +
          msg.tokens.reasoning +
          (msg.tokens.cache?.read ?? 0) +
          (msg.tokens.cache?.write ?? 0),
        inputTokens: msg.tokens.input,
        outputTokens: msg.tokens.output,
        thoughtTokens: msg.tokens.reasoning || undefined,
        cachedReadTokens: msg.tokens.cache?.read || undefined,
        cachedWriteTokens: msg.tokens.cache?.write || undefined,
      })

      if (!cmd) {
        const response = await this.sdk.session[":sessionID"].message
          .$post({
            param: { sessionID },
            json: {
              model: {
                providerID: model.providerID,
                modelID: model.modelID,
              },
              variant,
              parts,
              agent,
            },
            query: { directory },
          } as any)
          .then((r: any) => r.json())
        const msg = response?.info

        await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

        return {
          stopReason: "end_turn" as const,
          usage: msg ? buildUsage(msg) : undefined,
          _meta: {},
        }
      }

      const command = await this.config.sdk.command
        .$get({ query: { directory } } as any)
        .then((r: any) => r.json())
        .then((data: any) => (data as any[]).find((c: any) => c.name === cmd.name))
      if (command) {
        const response = await this.sdk.session[":sessionID"].command
          .$post({
            param: { sessionID },
            json: {
              command: command.name,
              arguments: cmd.args,
              model: model.providerID + "/" + model.modelID,
              variant,
              agent,
            },
            query: { directory },
          } as any)
          .then((r: any) => r.json())
        const msg = response?.info

        await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

        return {
          stopReason: "end_turn" as const,
          usage: msg ? buildUsage(msg) : undefined,
          _meta: {},
        }
      }

      switch (cmd.name) {
        case "compact":
          await this.config.sdk.session[":sessionID"].summarize.$post({
            param: { sessionID },
            json: { providerID: model.providerID, modelID: model.modelID },
            query: { directory },
          } as any)
          break
      }

      await sendUsageUpdate(this.connection, this.sdk, sessionID, directory)

      return {
        stopReason: "end_turn" as const,
        _meta: {},
      }
    }

    async cancel(params: CancelNotification) {
      const session = this.sessionManager.get(params.sessionId)
      await this.config.sdk.session[":sessionID"].abort.$post({
        param: { sessionID: params.sessionId },
        query: { directory: session.cwd },
      } as any)
    }
  }

  function toToolKind(toolName: string, input?: Record<string, any>): ToolKind {
    const tool = toolName.toLocaleLowerCase()
    switch (tool) {
      case "bash":
        return "execute"

      case "search_remote":
        if (input?.["mode"] === "fetch") return "fetch"
        return "search"

      case "search":
      case "lsp":
      case "context7_resolve_library_id":
      case "context7_get_library_docs":
        return "search"

      case "edit":
      case "apply_patch":
      case "multiedit":
        return "edit"

      case "read":
        return "read"

      // Legacy tool names may still appear in older ACP session history.
      case "webfetch":
        return "fetch"
      case "patch":
      case "write":
        return "edit"
      case "grep":
      case "glob":
        return "search"
      case "list":
        return "read"

      default:
        return "other"
    }
  }

  function toLocations(toolName: string, input?: Record<string, any>): { path: string }[] {
    const tool = toolName.toLocaleLowerCase()
    const data = input ?? {}
    switch (tool) {
      case "read":
      case "lsp":
        return typeof data["filePath"] === "string" ? [{ path: data["filePath"] }] : []

      case "search":
        return typeof data["path"] === "string" ? [{ path: data["path"] }] : []

      case "apply_patch":
        return applyPatchPaths(data).map(path => ({ path }))

      case "edit": {
        const direct = typeof data["filePath"] === "string" ? [data["filePath"]] : []
        const patch = applyPatchPaths(data)
        return Array.from(new Set([...direct, ...patch])).map(path => ({ path }))
      }

      // Legacy tool names may still appear in older ACP session history.
      case "write":
        return typeof data["filePath"] === "string" ? [{ path: data["filePath"] }] : []
      case "glob":
      case "grep":
      case "list":
        return typeof data["path"] === "string" ? [{ path: data["path"] }] : []

      case "bash":
      case "search_remote":
        return []

      default:
        return []
    }
  }

  function editDiffContent(
    toolName: string,
    input: Record<string, any>,
    metadata: Record<string, any> | undefined
  ): ToolCallContent[] {
    if (toolName.toLocaleLowerCase() === "apply_patch") {
      const files = Array.isArray(metadata?.["files"]) ? (metadata["files"] as Record<string, any>[]) : []
      const diff: ToolCallContent[] = []
      for (const file of files) {
        const filePath =
          typeof file["relativePath"] === "string"
            ? file["relativePath"]
            : typeof file["filePath"] === "string"
              ? file["filePath"]
              : ""
        if (!filePath) continue
        diff.push({
          type: "diff",
          path: filePath,
          oldText: typeof file["before"] === "string" ? file["before"] : "",
          newText: typeof file["after"] === "string" ? file["after"] : "",
        })
      }
      return diff
    }

    const filePath = typeof input["filePath"] === "string" ? input["filePath"] : ""
    if (!filePath) return []

    const oldText = typeof input["oldString"] === "string" ? input["oldString"] : ""
    const newText =
      typeof input["newString"] === "string"
        ? input["newString"]
        : typeof input["content"] === "string"
          ? input["content"]
          : ""

    return [
      {
        type: "diff",
        path: filePath,
        oldText,
        newText,
      },
    ]
  }

  function applyPatchPaths(input: Record<string, any>): string[] {
    const result = new Set<string>()

    if (typeof input["filepath"] === "string") {
      for (const item of input["filepath"].split(",")) {
        const path = item.trim()
        if (path) result.add(path)
      }
    }

    if (Array.isArray(input["files"])) {
      for (const file of input["files"] as Record<string, any>[]) {
        const filePath =
          typeof file["relativePath"] === "string"
            ? file["relativePath"]
            : typeof file["filePath"] === "string"
              ? file["filePath"]
              : ""
        if (filePath) result.add(filePath)
      }
    }

    if (typeof input["patchText"] === "string") {
      const prefixes = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "]
      for (const line of input["patchText"].split(/\r?\n/)) {
        for (const prefix of prefixes) {
          if (!line.startsWith(prefix)) continue
          const path = line.slice(prefix.length).trim()
          if (path) result.add(path)
        }
      }
    }

    return [...result]
  }

  async function defaultModel(config: ACPConfig, cwd?: string) {
    const sdk = config.sdk
    const configured = config.defaultModel
    if (configured) return configured

    const directory = cwd ?? process.cwd()

    const specified = await sdk.config
      .$get({ query: { directory } } as any)
      .then((r: any) => r.json())
      .then((cfg: any) => {
        if (!cfg || !cfg.model) return undefined
        const parsed = Provider.parseModel(cfg.model as string)
        return {
          providerID: parsed.providerID ?? "",
          modelID: parsed.modelID,
        }
      })
      .catch(error => {
        log.error("failed to load user config for default model", { error })
        return undefined
      })

    const providers = await sdk.provider
      .$get({ query: { directory } } as any)
      .then((r: any) => r.json())
      .then((data: any) => (data?.providers ?? []) as Provider.Info[])
      .catch(error => {
        log.error("failed to list providers for default model", { error })
        return [] as Provider.Info[]
      })

    if (specified && providers.length) {
      const provider = providers.find(p => p.id === specified.providerID)
      if (provider && provider.models[specified.modelID]) return specified
    }

    if (specified && !providers.length) return specified

    const models = providers.flatMap((p: Provider.Info) => Object.values(p.models))
    const [best] = Provider.sort(models)
    if (best) {
      return {
        providerID: best.providerID,
        modelID: best.id,
      }
    }

    if (specified) return specified

    return { providerID: "claude-code", modelID: "claude-sonnet-4-6" }
  }

  function parseUri(
    uri: string
  ): { type: "file"; url: string; filename: string; mime: string } | { type: "text"; text: string } {
    try {
      if (uri.startsWith("file://")) {
        const path = uri.slice(7)
        const name = path.split("/").pop() || path
        return {
          type: "file",
          url: uri,
          filename: name,
          mime: "text/plain",
        }
      }
      if (uri.startsWith("zed://")) {
        const url = new URL(uri)
        const path = url.searchParams.get("path")
        if (path) {
          const name = path.split("/").pop() || path
          return {
            type: "file",
            url: pathToFileURL(path).href,
            filename: name,
            mime: "text/plain",
          }
        }
      }
      return {
        type: "text",
        text: uri,
      }
    } catch {
      return {
        type: "text",
        text: uri,
      }
    }
  }

  function getNewContent(fileOriginal: string, unifiedDiff: string): string | undefined {
    const result = applyPatch(fileOriginal, unifiedDiff)
    if (result === false) {
      log.error("Failed to apply unified diff (context mismatch)")
      return undefined
    }
    return result
  }

  function sortProvidersByName<T extends { name: string }>(providers: T[]): T[] {
    return [...providers].sort((a, b) => {
      const nameA = a.name.toLowerCase()
      const nameB = b.name.toLowerCase()
      if (nameA < nameB) return -1
      if (nameA > nameB) return 1
      return 0
    })
  }

  function modelVariantsFromProviders(
    providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>,
    model: { providerID: string; modelID: string }
  ): string[] {
    const provider = providers.find(entry => entry.id === model.providerID)
    if (!provider) return []
    const modelInfo = provider.models[model.modelID]
    if (!modelInfo?.variants) return []
    return Object.keys(modelInfo.variants)
  }

  function buildAvailableModels(
    providers: Array<{ id: string; name: string; models: Record<string, any> }>,
    options: { includeVariants?: boolean } = {}
  ): ModelOption[] {
    const includeVariants = options.includeVariants ?? false
    return providers.flatMap(provider => {
      const models = Provider.sort(Object.values(provider.models) as any)
      return models.flatMap(model => {
        const base: ModelOption = {
          modelId: `${provider.id}/${model.id}`,
          name: `${provider.name}/${model.name}`,
        }
        if (!includeVariants || !model.variants) return [base]
        const variants = Object.keys(model.variants).filter(variant => variant !== DEFAULT_VARIANT_VALUE)
        const variantOptions = variants.map(variant => ({
          modelId: `${provider.id}/${model.id}/${variant}`,
          name: `${provider.name}/${model.name} (${variant})`,
        }))
        return [base, ...variantOptions]
      })
    })
  }

  function formatModelIdWithVariant(
    model: { providerID: string; modelID: string },
    variant: string | undefined,
    availableVariants: string[],
    includeVariant: boolean
  ) {
    const base = `${model.providerID}/${model.modelID}`
    if (!includeVariant || !variant || !availableVariants.includes(variant)) return base
    return `${base}/${variant}`
  }

  function buildVariantMeta(input: {
    model: { providerID: string; modelID: string }
    variant?: string
    availableVariants: string[]
  }) {
    return {
      zeroxzero: {
        modelId: `${input.model.providerID}/${input.model.modelID}`,
        variant: input.variant ?? null,
        availableVariants: input.availableVariants,
      },
    }
  }

  function parseModelSelection(
    modelId: string,
    providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>
  ): { model: { providerID: string; modelID: string }; variant?: string } {
    const raw = Provider.parseModel(modelId)
    const model = { providerID: raw.providerID ?? "", modelID: raw.modelID }
    const provider = providers.find(p => p.id === model.providerID)
    if (!provider) {
      return { model, variant: undefined }
    }

    // Check if modelID exists directly
    if (provider.models[model.modelID]) {
      return { model, variant: undefined }
    }

    // Try to extract variant from end of modelID (e.g., "claude-sonnet-4/high" -> model: "claude-sonnet-4", variant: "high")
    const segments = model.modelID.split("/")
    if (segments.length > 1) {
      const candidateVariant = segments[segments.length - 1]
      if (candidateVariant) {
        const baseModelId = segments.slice(0, -1).join("/")
        const baseModelInfo = provider.models[baseModelId]
        if (baseModelInfo?.variants && candidateVariant in baseModelInfo.variants) {
          return {
            model: { providerID: model.providerID, modelID: baseModelId },
            variant: candidateVariant,
          }
        }
      }
    }

    return { model, variant: undefined }
  }
}
