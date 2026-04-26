import { describe, expect, it } from "bun:test"
import type { ChatRequest, ChatResponse, ChatStreamEvent, Session } from "@anonymous-dev/0x0-contracts"
import type { ChatProvider } from "./providers/types"
import type { SessionRecord, SessionSnapshot } from "./worktree"
import { createWebSocketSession } from "./ws"

function fakeProvider(id: "codex" | "claude", configured = true, delayMs = 0): ChatProvider {
  return {
    id,
    info: {
      id,
      label: id === "codex" ? "Codex" : "Claude",
      configured,
      defaultModel: "test-model",
      models: ["test-model"],
    },
    async *stream(input: ChatRequest): AsyncGenerator<ChatStreamEvent> {
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      yield { type: "start", provider: id, model: input.model }
      yield { type: "text_delta", text: input.messages[0]?.content.includes("Complete") ? "let" : "hi" }
      yield { type: "done", provider: id, model: input.model, text: "done" }
    },
    async complete(input: ChatRequest): Promise<ChatResponse> {
      return {
        provider: id,
        model: input.model,
        text: "done",
      }
    },
  }
}

function fakeManager() {
  const sessions = new Map<string, SessionRecord>()
  const refs = (id: string) => ({
    baseRef: `refs/0x0/session/${id}/baseline`,
    agentRef: `refs/0x0/session/${id}/head`,
  })
  const snapshot = (session: SessionRecord): SessionSnapshot => ({
    session,
    files: [],
  })

  return {
    listSessions() {
      return [...sessions.values()]
    },
    getSession(sessionId: string) {
      return sessions.get(sessionId)
    },
    async createSession(input: Pick<Session, "repoRoot" | "provider" | "model">) {
      const id = "session-1"
      const session: SessionRecord = {
        id,
        repoRoot: input.repoRoot,
        provider: input.provider,
        model: input.model,
        createdAt: "2026-04-25T00:00:00.000Z",
        messages: [],
        worktreePath: "",
        ...refs(id),
      }
      sessions.set(id, session)
      return session
    },
    async updateSessionMessages(sessionId: string, messages: Session["messages"]) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      session.messages = messages
      return session
    },
    async checkpoint(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async sync(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async status(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async acceptAll(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async discardAll(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async acceptFile(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
    async discardFile(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error("Unknown session")
      }
      return snapshot(session)
    },
  }
}

function waitFor(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - started > 1000) {
        reject(new Error("Timed out waiting for WebSocket test messages."))
        return
      }
      setTimeout(check, 0)
    }
    check()
  })
}

describe("websocket session", () => {
  it("creates sessions and streams chat turns with session-scoped messages", async () => {
    const sent: unknown[] = []
    const session = createWebSocketSession(
      {
        codex: fakeProvider("codex"),
        claude: fakeProvider("claude"),
      },
      fakeManager(),
      message => sent.push(message)
    )

    session.open()
    session.message(
      JSON.stringify({
        type: "session.create",
        id: "create-1",
        repoRoot: "/repo",
        provider: "codex",
        model: "test-model",
      })
    )
    await waitFor(() => sent.some(message => (message as { type?: string }).type === "session.created"))

    const created = sent.find(
      (message): message is { type: "session.created"; session: { id: string } } =>
        (message as { type?: string }).type === "session.created"
    )
    expect(created).toBeDefined()

    session.message(
      JSON.stringify({
        type: "chat.turn",
        id: "turn-1",
        sessionId: created?.session.id,
        prompt: "hello",
      })
    )

    await waitFor(() => sent.some(message => (message as { type?: string }).type === "assistant.delta"))

    expect(sent).toContainEqual({
      type: "assistant.delta",
      id: "turn-1",
      sessionId: created?.session.id,
      text: "hi",
    })
    expect(sent).toContainEqual({
      type: "changes.updated",
      id: "turn-1",
      sessionId: created?.session.id,
      files: [],
      baseRef: `0x0/session/${created?.session.id}/baseline`,
      agentRef: `0x0/session/${created?.session.id}/head`,
    })
    expect(sent).toContainEqual({
      type: "assistant.done",
      id: "turn-1",
      sessionId: created?.session.id,
      summary: "done",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    })
  })

  it("queues chat turns while a session turn is active", async () => {
    const sent: unknown[] = []
    const session = createWebSocketSession(
      {
        codex: fakeProvider("codex", true, 20),
        claude: fakeProvider("claude"),
      },
      fakeManager(),
      message => sent.push(message)
    )

    session.message(
      JSON.stringify({
        type: "session.create",
        id: "create-1",
        repoRoot: "/repo",
        provider: "codex",
        model: "test-model",
      })
    )
    await waitFor(() => sent.some(message => (message as { type?: string }).type === "session.created"))

    const created = sent.find(
      (message): message is { type: "session.created"; session: { id: string } } =>
        (message as { type?: string }).type === "session.created"
    )
    expect(created).toBeDefined()

    session.message(
      JSON.stringify({
        type: "chat.turn",
        id: "turn-1",
        sessionId: created?.session.id,
        prompt: "first",
      })
    )
    await waitFor(() => sent.some(message => (message as { type?: string }).type === "run.status"))
    session.message(
      JSON.stringify({
        type: "chat.turn",
        id: "turn-2",
        sessionId: created?.session.id,
        prompt: "second",
      })
    )

    await waitFor(() => sent.some(message => (message as { type?: string }).type === "user.queued"))
    expect(sent).toContainEqual({
      type: "user.queued",
      id: "turn-2",
      sessionId: created?.session.id,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    })
    await waitFor(() => sent.some(message => (message as { type?: string }).type === "assistant.done"))
    expect(sent).toContainEqual({
      type: "assistant.done",
      id: "turn-1",
      sessionId: created?.session.id,
      summary: "done",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "assistant", content: "hi" },
      ],
    })
  })

  it("returns inline edit replacements", async () => {
    const sent: unknown[] = []
    const session = createWebSocketSession(
      {
        codex: fakeProvider("codex"),
        claude: fakeProvider("claude"),
      },
      fakeManager(),
      message => sent.push(message)
    )

    session.message(
      JSON.stringify({
        type: "inline.edit",
        id: "inline-1",
        repoRoot: "/repo",
        file: "example.ts",
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
        prompt: "make it better",
        text: "const",
      })
    )

    await waitFor(() => sent.some(message => (message as { type?: string }).type === "inline.result"))

    expect(sent).toContainEqual({
      type: "inline.result",
      id: "inline-1",
      replacementText: "done",
    })
  })

  it("streams chat events with request ids", async () => {
    const sent: unknown[] = []
    const session = createWebSocketSession(
      {
        codex: fakeProvider("codex"),
        claude: fakeProvider("claude"),
      },
      fakeManager(),
      message => sent.push(message)
    )

    session.open()
    session.message(
      JSON.stringify({
        type: "chat",
        id: "req-1",
        request: {
          provider: "codex",
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      })
    )

    await waitFor(() => sent.some(message => (message as { type?: string }).type === "chat_event"))

    expect(sent[0]).toEqual({ type: "ready", protocolVersion: 1 })
    expect(sent).toContainEqual({
      type: "chat_event",
      id: "req-1",
      event: { type: "text_delta", text: "hi" },
    })
  })

  it("accepts completion requests and chooses the default configured provider", async () => {
    const sent: unknown[] = []
    const session = createWebSocketSession(
      {
        codex: fakeProvider("codex"),
        claude: fakeProvider("claude"),
      },
      fakeManager(),
      message => sent.push(message)
    )

    session.message(
      JSON.stringify({
        type: "completion",
        id: "completion-1",
        request: {
          prefix: "const value = ",
          suffix: "",
          language: "typescript",
          filepath: "example.ts",
          stream: true,
        },
      })
    )

    await waitFor(() => sent.some(message => (message as { type?: string }).type === "chat_event"))

    expect(sent).toContainEqual({
      type: "chat_event",
      id: "completion-1",
      event: { type: "text_delta", text: "let" },
    })
  })
})
