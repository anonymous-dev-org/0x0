import { Log } from "@/util/log"

const log = Log.create({ service: "codex-rpc" })

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type ServerRequestHandler = (params: unknown) => Promise<unknown>
type NotificationHandler = (params: unknown) => void

export class CodexRpcClient {
  private proc: ReturnType<typeof Bun.spawn>
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private requestHandlers = new Map<string, ServerRequestHandler>()
  private notificationHandlers = new Map<string, NotificationHandler[]>()
  private closeHandlers: Array<(reason: string) => void> = []
  private closed = false

  private constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc
  }

  static async create(cwd?: string): Promise<CodexRpcClient> {
    const codexPath = Bun.which("codex")
    if (!codexPath) throw new Error("codex binary not found in PATH")

    const proc = Bun.spawn([codexPath, "app-server", "--listen", "stdio://"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    })

    const client = new CodexRpcClient(proc)
    client.startReader()

    await client.request("initialize", {
      clientInfo: { name: "0x0", title: "0x0", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    })
    client.notify("initialized", {})

    return client
  }

  private startReader() {
    const stdout = this.proc.stdout
    if (!stdout || typeof stdout === "number") return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const pump = async () => {
      try {
        while (!this.closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let newline = buffer.indexOf("\n")
          while (newline !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.trim()) {
              try {
                this.dispatch(JSON.parse(line))
              } catch (e) {
                log.error("bad jsonrpc line", { line, error: e })
              }
            }
            newline = buffer.indexOf("\n")
          }
        }
      } catch (e) {
        if (!this.closed) log.error("stdout read error", { error: e })
      }

      // Process stdout closed — treat as unexpected exit if not already closed
      if (!this.closed) {
        this.handleProcessExit("codex process exited unexpectedly")
      }
    }
    pump()

    // Also read stderr for diagnostics
    this.readStderr()
  }

  private readStderr() {
    const stderr = this.proc.stderr
    if (!stderr || typeof stderr === "number") return
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const pump = async () => {
      try {
        while (!this.closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf("\n")
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) log.warn("codex stderr", { line })
            newline = buffer.indexOf("\n")
          }
        }
        if (buffer.trim()) log.warn("codex stderr", { line: buffer.trim() })
      } catch {}
    }
    pump()
  }

  private handleProcessExit(reason: string) {
    if (this.closed) return
    log.error("codex process exit", { reason })
    this.closed = true
    try { this.proc.kill() } catch {}
    for (const [, p] of this.pending) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
    for (const h of this.closeHandlers) h(reason)
    this.closeHandlers = []
  }

  private dispatch(msg: Record<string, unknown>) {
    const hasId = "id" in msg
    const hasMethod = "method" in msg
    const hasResult = "result" in msg || "error" in msg

    if (hasId && hasResult && !hasMethod) {
      const id = msg.id as number
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)

      if (msg.error) {
        const err = msg.error as { code?: number; message?: string }
        pending.reject(new Error(`RPC ${err.code ?? -1}: ${err.message ?? "unknown"}`))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (hasId && hasMethod) {
      const method = msg.method as string
      const id = msg.id as number
      const handler = this.requestHandlers.get(method)

      if (handler) {
        handler(msg.params).then(
          (result) => this.send({ id, result }),
          (error) => this.send({ id, error: { code: -32000, message: String(error) } }),
        )
      } else {
        log.warn("unhandled server request", { method })
        this.send({ id, error: { code: -32601, message: `No handler for ${method}` } })
      }
      return
    }

    if (hasMethod) {
      const method = msg.method as string
      const handlers = this.notificationHandlers.get(method)
      if (handlers) {
        for (const h of handlers) h(msg.params)
      }
    }
  }

  private send(msg: unknown) {
    if (this.closed) return
    const stdin = this.proc.stdin
    if (!stdin || typeof stdin === "number") return
    stdin.write(JSON.stringify(msg) + "\n")
    stdin.flush()
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) throw new Error("client closed")
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: "2.0", method, id, params })
    })
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  onServerRequest(method: string, handler: ServerRequestHandler) {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler) {
    const list = this.notificationHandlers.get(method) ?? []
    list.push(handler)
    this.notificationHandlers.set(method, list)
  }

  onClose(handler: (reason: string) => void) {
    if (this.closed) {
      handler("already closed")
      return
    }
    this.closeHandlers.push(handler)
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.proc.kill() } catch {}
    for (const [, p] of this.pending) {
      p.reject(new Error("client closed"))
    }
    this.pending.clear()
    this.closeHandlers = []
  }
}
