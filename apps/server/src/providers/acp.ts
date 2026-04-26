import { existsSync } from "node:fs"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import type { ChatProvider } from "./types"
import type { ChatRequest, ChatResponse, ChatStreamEvent, ProviderId } from "@anonymous-dev/0x0-contracts"

type AcpProviderOptions = {
  id: ProviderId
  label: string
  command: string
  args?: string[]
  defaultModel: string
  models: string[]
  authMethod?: string
  defaultMode?: string
}

type AcpSessionHandlers = {
  onDelta?: (text: string) => void
  onStatus?: (status: string) => void
}

function resolveCommand(command: string) {
  if (command.includes("/") && existsSync(command)) {
    return command
  }

  const candidates = [
    path.join(process.cwd(), "node_modules", ".bin", command),
    path.join(process.cwd(), "apps", "server", "node_modules", ".bin", command),
    path.join(import.meta.dir, "..", "node_modules", ".bin", command),
    path.join(import.meta.dir, "..", "..", "node_modules", ".bin", command),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return command
}

function isCommandAvailable(command: string) {
  const resolved = resolveCommand(command)
  if (resolved !== command && existsSync(resolved)) {
    return true
  }
  return Boolean(Bun.which(command))
}

function requestToPrompt(input: ChatRequest): ContentBlock[] {
  const text = input.messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n")
  return [{ type: "text", text }]
}

function textFromUpdate(params: SessionNotification) {
  const update = params.update
  if (update.sessionUpdate !== "agent_message_chunk") {
    return undefined
  }
  const content = update.content
  return content.type === "text" ? content.text : undefined
}

function choosePermissionOption(request: RequestPermissionRequest) {
  return (
    request.options.find(option => option.kind === "allow_once") ??
    request.options.find(option => option.kind === "allow_always") ??
    request.options.find(option => option.kind === "reject_once") ??
    request.options.find(option => option.kind === "reject_always")
  )
}

function isSelectGroup(value: SessionConfigSelectOption | SessionConfigSelectGroup): value is SessionConfigSelectGroup {
  return "group" in value
}

function hasSelectValue(option: SessionConfigOption, value: string) {
  if (option.type !== "select") {
    return false
  }

  return option.options.some(candidate => {
    if (isSelectGroup(candidate)) {
      return candidate.options.some(grouped => grouped.value === value)
    }
    return candidate.value === value
  })
}

export class AcpProvider implements ChatProvider {
  readonly id: ProviderId
  readonly info: ChatProvider["info"]

  private readonly command: string
  private readonly args: string[]
  private readonly authMethod?: string
  private readonly defaultMode?: string
  private process?: ChildProcessWithoutNullStreams
  private connection?: ClientSideConnection
  private initializeResponse?: InitializeResponse
  private readonly sessionHandlers = new Map<string, AcpSessionHandlers>()
  private readonly logicalSessions = new Map<string, string>()

  constructor(options: AcpProviderOptions) {
    this.id = options.id
    this.command = resolveCommand(options.command)
    this.args = options.args ?? []
    this.authMethod = options.authMethod
    this.defaultMode = options.defaultMode
    this.info = {
      id: options.id,
      label: options.label,
      defaultModel: options.defaultModel,
      models: options.models,
      configured: isCommandAvailable(options.command),
    }
  }

  async *stream(input: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    let text = ""
    const chunks: string[] = []
    let done = false
    let error: unknown
    let wake: (() => void) | undefined
    const wakeReader = () => {
      wake?.()
      wake = undefined
    }

    yield { type: "start", provider: this.id, model: input.model }
    const session = await this.createAcpSession(process.cwd(), { model: input.model, effort: input.effort })
    const prompt = this.promptSession({
      sessionId: session.sessionId,
      prompt: requestToPrompt(input),
      signal,
      onDelta: delta => {
        text += delta
        chunks.push(delta)
        wakeReader()
      },
    })

    const finished = prompt
      .catch(caught => {
        error = caught
        return undefined
      })
      .finally(() => {
        done = true
        wakeReader()
      })

    while (!done || chunks.length > 0) {
      while (chunks.length > 0) {
        const chunk = chunks.shift()
        if (chunk) {
          yield { type: "text_delta", text: chunk }
        }
      }
      if (!done) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }

    const summary = await finished
    if (error) {
      throw error
    }
    yield { type: "done", provider: this.id, model: input.model, text: summary || text }
  }

  async complete(input: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    let text = ""
    const session = await this.createAcpSession(process.cwd(), { model: input.model, effort: input.effort })
    const summary = await this.promptSession({
      sessionId: session.sessionId,
      prompt: requestToPrompt(input),
      signal,
      onDelta: delta => {
        text += delta
      },
    })
    return {
      provider: this.id,
      model: input.model,
      text: text || summary,
    }
  }

  async runSessionTurn(input: {
    sessionId: string
    cwd: string
    prompt: string
    effort?: string
    signal?: AbortSignal
    onDelta?: (text: string) => void
    onStatus?: (status: string) => void
  }) {
    const acpSessionId = await this.getOrCreateLogicalSession(input.sessionId, input.cwd, input.effort)
    return this.promptSession({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: input.prompt }],
      signal: input.signal,
      onDelta: input.onDelta,
      onStatus: input.onStatus,
    })
  }

  async cancelSession(sessionId: string) {
    await this.ensureConnection()
    await this.connection?.cancel({ sessionId: this.logicalSessions.get(sessionId) ?? sessionId })
  }

  close() {
    this.connection = undefined
    this.initializeResponse = undefined
    this.sessionHandlers.clear()
    this.process?.kill()
    this.process = undefined
  }

  private async getOrCreateLogicalSession(logicalSessionId: string, cwd: string, effort?: string) {
    const existing = this.logicalSessions.get(logicalSessionId)
    if (existing) {
      return existing
    }
    const session = await this.createAcpSession(cwd, { mode: this.defaultMode, effort })
    this.logicalSessions.set(logicalSessionId, session.sessionId)
    return session.sessionId
  }

  private async createAcpSession(cwd: string, initial: { model?: string; mode?: string; effort?: string } = {}) {
    const connection = await this.ensureConnection()
    const result = await connection.newSession({
      cwd,
      mcpServers: [],
    })

    if (initial.model) {
      await this.setInitialModel(result, initial.model)
    }
    if (initial.mode) {
      await this.setInitialMode(result, initial.mode)
    }
    if (initial.effort) {
      await this.setInitialEffort(result, initial.effort)
    }

    return result
  }

  private async setInitialModel(session: NewSessionResponse, model: string) {
    if (!model) {
      return
    }

    const configOption = session.configOptions?.find(
      option => option.category === "model" && hasSelectValue(option, model),
    )
    if (configOption) {
      await this.connection?.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: configOption.id,
        value: model,
      })
      return
    }

    if (session.models?.availableModels.some(available => available.modelId === model)) {
      await this.connection?.unstable_setSessionModel({ sessionId: session.sessionId, modelId: model }).catch(
        () => undefined,
      )
    }
  }

  private async setInitialMode(session: NewSessionResponse, mode: string) {
    const configOption = session.configOptions?.find(
      option => option.category === "mode" && hasSelectValue(option, mode),
    )
    if (configOption) {
      await this.connection?.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: configOption.id,
        value: mode,
      })
      return
    }

    if (session.modes?.availableModes.some(available => available.id === mode)) {
      await this.connection?.setSessionMode({ sessionId: session.sessionId, modeId: mode }).catch(() => undefined)
    }
  }

  private async setInitialEffort(session: NewSessionResponse, effort: string) {
    const effortCategories = new Set(["effort", "reasoning_effort", "reasoning-effort", "thinking_effort"])
    const configOption = session.configOptions?.find(
      option => typeof option.category === "string" && effortCategories.has(option.category) && hasSelectValue(option, effort),
    )
    if (!configOption) {
      return
    }
    await this.connection?.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: configOption.id,
      value: effort,
    })
  }

  private async promptSession(input: {
    sessionId: string
    prompt: ContentBlock[]
    signal?: AbortSignal
    onDelta?: (text: string) => void
    onStatus?: (status: string) => void
  }) {
    const connection = await this.ensureConnection()
    let text = ""

    const abort = () => {
      void connection.cancel({ sessionId: input.sessionId })
    }
    input.signal?.addEventListener("abort", abort, { once: true })

    this.sessionHandlers.set(input.sessionId, {
      onDelta: delta => {
        text += delta
        input.onDelta?.(delta)
      },
      onStatus: input.onStatus,
    })

    try {
      input.onStatus?.("running")
      const response = await connection.prompt({
        sessionId: input.sessionId,
        prompt: input.prompt,
      })
      input.onStatus?.(response.stopReason)
      return text
    } finally {
      input.signal?.removeEventListener("abort", abort)
      this.sessionHandlers.delete(input.sessionId)
    }
  }

  private async ensureConnection() {
    if (this.connection) {
      return this.connection
    }

    if (!this.info.configured) {
      throw new Error(`${this.info.label} ACP command is not available: ${this.command}`)
    }

    this.process = spawn(this.command, this.args, {
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        IS_AI_TERMINAL: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.process.stderr.on("data", data => {
      const text = String(data).trim()
      if (text) {
        console.error(`[${this.id}-acp] ${text}`)
      }
    })

    const client: Client = {
      requestPermission: request => this.handlePermissionRequest(request),
      sessionUpdate: params => this.handleSessionUpdate(params),
    }

    const toWritableWeb = Writable as unknown as {
      toWeb(stream: NodeJS.WritableStream): WritableStream<Uint8Array>
    }
    const toReadableWeb = Readable as unknown as {
      toWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array>
    }
    const stream = ndJsonStream(toWritableWeb.toWeb(this.process.stdin), toReadableWeb.toWeb(this.process.stdout))
    this.connection = new ClientSideConnection(() => client, stream)
    this.initializeResponse = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: "0x0",
        title: "0x0",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    })

    if (this.authMethod) {
      await this.connection.authenticate({ methodId: this.authMethod })
    }

    this.process.once("exit", () => {
      this.connection = undefined
      this.initializeResponse = undefined
      this.sessionHandlers.clear()
      this.logicalSessions.clear()
      this.process = undefined
    })

    return this.connection
  }

  private async handlePermissionRequest(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const option = choosePermissionOption(request)
    if (!option || option.kind.startsWith("reject")) {
      return { outcome: { outcome: "cancelled" } }
    }
    return {
      outcome: {
        outcome: "selected",
        optionId: option.optionId,
      },
    }
  }

  private async handleSessionUpdate(params: SessionNotification) {
    const handler = this.sessionHandlers.get(params.sessionId)
    if (!handler) {
      return
    }

    const delta = textFromUpdate(params)
    if (delta) {
      handler.onDelta?.(delta)
      return
    }

    const update = params.update
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      handler.onStatus?.(update.title ?? update.kind ?? update.status ?? "tool")
      return
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      handler.onStatus?.("thinking")
    }
  }
}
