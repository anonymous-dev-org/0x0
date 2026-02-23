import { Log } from "@/util/log"
import { CodexRpcClient } from "./client"

const log = Log.create({ service: "codex-app-server" })

export type CodexEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "tool-start"; id: string; tool: string; command?: string }
  | { type: "tool-output"; id: string; output: string }
  | { type: "tool-end"; id: string; output: string; exitCode?: number }
  | { type: "file-change"; id: string; files: Array<{ path: string; kind: string }> }
  | { type: "step-start" }
  | { type: "step-end" }
  | { type: "done"; threadId: string }
  | { type: "error"; message: string }

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

export type CodexStreamInput = {
  modelId: string
  prompt: string
  systemPrompt?: string
  threadId?: string
  abort: AbortSignal
  cwd?: string
  approvalPolicy?: "never" | "on-request"
  onCommandApproval?: (params: {
    command: string
    cwd: string
    reason?: string
  }) => Promise<CodexApprovalDecision>
  onFileChangeApproval?: (params: {
    reason?: string
  }) => Promise<CodexApprovalDecision>
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export async function* codexAppServerStream(
  input: CodexStreamInput,
): AsyncGenerator<CodexEvent> {
  const queue: CodexEvent[] = []
  let wake: (() => void) | null = null
  let turnDone = false

  function push(event: CodexEvent) {
    queue.push(event)
    if (wake) {
      wake()
      wake = null
    }
  }

  function finish() {
    turnDone = true
    if (wake) {
      wake()
      wake = null
    }
  }

  function waitForEvents(): Promise<void> {
    if (queue.length > 0 || turnDone) return Promise.resolve()
    return new Promise((r) => {
      wake = r
    })
  }

  let client: CodexRpcClient | undefined

  const abortHandler = () => {
    finish()
    client?.close()
  }

  if (input.abort.aborted) return
  input.abort.addEventListener("abort", abortHandler, { once: true })

  try {
    client = await CodexRpcClient.create(input.cwd)

    // ── Detect unexpected process exit ─────────────────────────────────

    client.onClose((reason) => {
      if (!turnDone) {
        push({ type: "error", message: reason })
        finish()
      }
    })

    // ── Approval handlers ──────────────────────────────────────────────

    client.onServerRequest(
      "item/commandExecution/requestApproval",
      async (params) => {
        const p = obj(params)
        if (input.onCommandApproval) {
          const decision = await input.onCommandApproval({
            command: str(p.command),
            cwd: str(p.cwd),
            reason: typeof p.reason === "string" ? p.reason : undefined,
          })
          return { decision }
        }
        return { decision: "accept" }
      },
    )

    client.onServerRequest(
      "item/fileChange/requestApproval",
      async (params) => {
        const p = obj(params)
        if (input.onFileChangeApproval) {
          const decision = await input.onFileChangeApproval({
            reason: typeof p.reason === "string" ? p.reason : undefined,
          })
          return { decision }
        }
        return { decision: "accept" }
      },
    )

    // ── Streaming delta notifications ──────────────────────────────────

    client.onNotification("item/agentMessage/delta", (params) => {
      const p = obj(params)
      const delta = str(p.delta)
      if (delta) push({ type: "text-delta", text: delta })
    })

    client.onNotification("item/commandExecution/outputDelta", (params) => {
      const p = obj(params)
      const delta = str(p.delta)
      if (delta) push({ type: "tool-output", id: str(p.itemId), output: delta })
    })

    client.onNotification("item/reasoning/textDelta", (params) => {
      const p = obj(params)
      const delta = str(p.delta)
      if (delta) push({ type: "reasoning-delta", id: str(p.itemId), text: delta })
    })

    // ── Item lifecycle notifications ───────────────────────────────────

    client.onNotification("item/started", (params) => {
      const p = obj(params)
      const item = obj(p.item)

      if (str(item.type) === "commandExecution") {
        push({
          type: "tool-start",
          id: str(item.id),
          tool: "bash",
          command: str(item.command),
        })
      }
    })

    client.onNotification("item/completed", (params) => {
      const p = obj(params)
      const item = obj(p.item)
      const itemType = str(item.type)

      if (itemType === "commandExecution") {
        push({
          type: "tool-end",
          id: str(item.id),
          output: str(item.aggregatedOutput),
          exitCode: num(item.exitCode),
        })
      } else if (itemType === "fileChange") {
        const changes = arr(item.changes)
        if (changes.length > 0) {
          push({
            type: "file-change",
            id: str(item.id),
            files: changes.map((c) => {
              const change = obj(c)
              return { path: str(change.path), kind: str(change.kind) || "modified" }
            }),
          })
        }
      }
    })

    // ── Turn lifecycle ─────────────────────────────────────────────────

    let resolvedThreadId = input.threadId ?? ""

    client.onNotification("turn/started", () => {
      push({ type: "step-start" })
    })

    client.onNotification("turn/completed", (params) => {
      const p = obj(params)
      const threadId = str(p.threadId) || resolvedThreadId
      push({ type: "step-end" })
      if (threadId) push({ type: "done", threadId })
      finish()
    })

    client.onNotification("error", (params) => {
      const p = obj(params)
      const error = obj(p.error)
      push({ type: "error", message: str(error.message) || "Codex error" })
      finish()
    })

    // ── Start or resume thread ─────────────────────────────────────────

    const policy = input.approvalPolicy ?? "never"

    log.info("codex thread", {
      action: input.threadId ? "resume" : "start",
      model: input.modelId,
      policy,
    })

    const threadResult = obj(
      input.threadId
        ? await client.request("thread/resume", {
            threadId: input.threadId,
            approvalPolicy: policy,
            developerInstructions: input.systemPrompt || undefined,
          })
        : await client.request("thread/start", {
            model: input.modelId || undefined,
            cwd: input.cwd,
            approvalPolicy: policy,
            developerInstructions: input.systemPrompt || undefined,
          }),
    )

    const thread = obj(threadResult.thread)
    resolvedThreadId = str(thread.id) || resolvedThreadId

    log.info("codex thread ready", { threadId: resolvedThreadId })

    // ── Start turn ─────────────────────────────────────────────────────

    await client.request("turn/start", {
      threadId: resolvedThreadId,
      input: [{ type: "text", text: input.prompt }],
      cwd: input.cwd,
      model: input.modelId || undefined,
      approvalPolicy: policy,
    })

    log.info("codex turn started", { threadId: resolvedThreadId })

    // ── Drain event queue until turn completes ─────────────────────────

    while (!turnDone || queue.length > 0) {
      await waitForEvents()
      while (queue.length > 0) {
        yield queue.shift()!
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return
    const msg = err instanceof Error ? err.message : String(err)
    if (!turnDone) yield { type: "error", message: msg }
  } finally {
    input.abort.removeEventListener("abort", abortHandler)
    client?.close()
  }
}
