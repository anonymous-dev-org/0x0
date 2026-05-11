import { describe, expect, it } from "bun:test"
import { createServer } from "../src/server"
import { Session, type SessionDeps } from "../src/session"
import { Transport } from "../src/transport"
import type {
  InitializeResult,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  SessionNewResult,
  SessionPromptResult,
  SessionUpdate,
  SessionUpdateParams,
} from "../src/types"
import type { ClaudeClient, ClaudeStreamRequest } from "../src/claude"
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages"

function makePipedTransports() {
  const clientToServer: ((msg: RpcMessage) => void)[] = []
  const serverToClient: ((msg: RpcMessage) => void)[] = []

  const client = new Transport(line => {
    const msg = JSON.parse(line.trim()) as RpcMessage
    for (const fn of clientToServer) fn(msg)
  })
  const server = new Transport(line => {
    const msg = JSON.parse(line.trim()) as RpcMessage
    for (const fn of serverToClient) fn(msg)
  })
  clientToServer.push(m => server.feed(JSON.stringify(m) + "\n"))
  serverToClient.push(m => client.feed(JSON.stringify(m) + "\n"))
  return { client, server }
}

function stubClaude(events: RawMessageStreamEvent[]): ClaudeClient {
  return {
    async *stream(_req: ClaudeStreamRequest) {
      for (const e of events) yield e
    },
  }
}

describe("Server.initialize", () => {
  it("responds with agentCapabilities", async () => {
    const { client, server } = makePipedTransports()
    createServer(server, {})

    const responses: RpcResponse[] = []
    client.onMessage(m => {
      if ("id" in m && !("method" in m)) responses.push(m as RpcResponse)
    })

    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-01" },
    } as RpcRequest)

    await new Promise(r => setTimeout(r, 10))
    expect(responses).toHaveLength(1)
    const result = responses[0].result as InitializeResult
    expect(result.agentInfo.name).toBe("claude-agent-server")
    expect(result.agentCapabilities).toBeDefined()
  })
})

describe("Server.session_new", () => {
  it("creates a session and responds with a sessionId + configOptions", async () => {
    const { client, server } = makePipedTransports()
    createServer(server, {})

    const responses: RpcResponse[] = []
    client.onMessage(m => {
      if ("id" in m && !("method" in m)) responses.push(m as RpcResponse)
    })

    client.send({
      jsonrpc: "2.0",
      id: 7,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    } as RpcRequest)

    await new Promise(r => setTimeout(r, 10))
    expect(responses).toHaveLength(1)
    const result = responses[0].result as SessionNewResult
    expect(result.sessionId).toMatch(/^cas-/)
    expect(result.configOptions.length).toBeGreaterThan(0)
  })

  it("emits agent_message_chunk for streamed text via the Session directly", async () => {
    const events: RawMessageStreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } as never },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } as never },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } as never },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } as never, usage: {} as never },
      { type: "message_stop" },
    ]
    const updates: SessionUpdate[] = []
    const session = new Session(
      "s_text",
      "/tmp",
      { sessionId: "s_text", notify: u => updates.push(u), request: () => Promise.reject(new Error("no")) },
      { defaultModel: "claude-sonnet-4-6", models: ["claude-sonnet-4-6"], claude: stubClaude(events) }
    )
    const reason = await session.prompt([{ type: "text", text: "hi" }])
    expect(reason).toBe("end_turn")
    const text = updates
      .filter(u => u.sessionUpdate === "agent_message_chunk")
      .map(u => (u as { content: { text: string } }).content.text)
      .join("")
    expect(text).toBe("hello world")
  })
})

// Smoke: dispatch a tool_use turn → server emits tool_call,
// returns the request via the deps.request hook, then the model
// resolves with end_turn.
describe("Session.tool_use round-trip", () => {
  it("emits tool_call, dispatches the tool, then ends the turn", async () => {
    const events1: RawMessageStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } as never,
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/x.txt"}' } as never,
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } as never, usage: {} as never },
      { type: "message_stop" },
    ]
    const events2: RawMessageStreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } as never },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } as never },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } as never, usage: {} as never },
      { type: "message_stop" },
    ]
    const rounds = [events1, events2]
    const claude: ClaudeClient = {
      async *stream() {
        const next = rounds.shift() ?? []
        for (const e of next) yield e
      },
    }

    const updates: SessionUpdate[] = []
    let requested: { method: string; params: unknown } | null = null
    const deps: SessionDeps = {
      sessionId: "s1",
      notify: u => updates.push(u),
      request: <T,>(method: string, params: unknown): Promise<T> => {
        requested = { method, params }
        return Promise.resolve({ content: "file body" } as T)
      },
    }

    const session = new Session("s1", "/tmp", deps, {
      defaultModel: "claude-sonnet-4-6",
      models: ["claude-sonnet-4-6"],
      claude,
    })

    const reason = await session.prompt([{ type: "text", text: "read /tmp/x.txt" }])
    expect(reason).toBe("end_turn")
    expect(requested).toBeTruthy()
    if (requested) {
      expect((requested as { method: string }).method).toBe("fs/read_text_file")
    }
    const calls = updates.filter(u => u.sessionUpdate === "tool_call")
    const updatesForTool = updates.filter(u => u.sessionUpdate === "tool_call_update")
    expect(calls).toHaveLength(1)
    expect(updatesForTool[updatesForTool.length - 1]).toMatchObject({ status: "completed" })
  })
})

// Cancellation: aborting the abortController mid-stream resolves with
// "cancelled".
describe("Session.concurrent_prompt (T1.6)", () => {
  it("rejects a second prompt while the first is running", async () => {
    // First stream blocks until aborted.
    const claude: ClaudeClient = {
      async *stream(req) {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } as never }
        await new Promise<void>((_resolve, reject) => {
          if (req.signal) {
            req.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            )
          }
        })
      },
    }
    const session = new Session(
      "s_busy",
      "/tmp",
      { sessionId: "s_busy", notify: () => {}, request: () => Promise.reject(new Error("no")) },
      { defaultModel: "claude-sonnet-4-6", models: ["claude-sonnet-4-6"], claude }
    )
    const first = session.prompt([{ type: "text", text: "first" }])
    await new Promise(r => setTimeout(r, 10))
    let err: Error | null = null
    try {
      await session.prompt([{ type: "text", text: "second" }])
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    expect(err?.message).toMatch(/busy/)
    session.cancel()
    await first.catch(() => {})
  })
})

describe("Session.empty_round (T1.8)", () => {
  it("does not push an empty assistant message when the round produced no blocks", async () => {
    const claude: ClaudeClient = {
      async *stream() {
        yield { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } as never, usage: {} as never }
        yield { type: "message_stop" } as never
      },
    }
    const session = new Session(
      "s_empty",
      "/tmp",
      { sessionId: "s_empty", notify: () => {}, request: () => Promise.reject(new Error("no")) },
      { defaultModel: "claude-sonnet-4-6", models: ["claude-sonnet-4-6"], claude }
    )
    const reason = await session.prompt([{ type: "text", text: "hi" }])
    expect(reason).toBe("end_turn")
    // History should contain only the user message we just pushed (no
    // assistant tail). Access via a one-shot second prompt's stream which
    // requires history to remain consistent — instead, inspect via the
    // public surface: a follow-up prompt should not throw. The contract
    // is "no empty assistant content was inserted".
    // We can probe by issuing another prompt with a stub that records
    // the history it sees.
    let seenMessages: unknown[] = []
    const claude2: ClaudeClient = {
      async *stream(req) {
        // Snapshot the messages array; req.messages aliases history which
        // mutates as soon as the stream completes (assistant push).
        seenMessages = JSON.parse(JSON.stringify(req.messages))
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } as never }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } as never }
        yield { type: "content_block_stop", index: 0 }
        yield { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } as never, usage: {} as never }
        yield { type: "message_stop" } as never
      },
    }
    ;(session as unknown as { claudeInstance: ClaudeClient | null }).claudeInstance = claude2
    await session.prompt([{ type: "text", text: "again" }])
    // History fed into the second stream should be only the two user
    // messages — no orphan empty assistant block in between.
    const assistantsBefore = seenMessages.filter(
      m => (m as { role: string }).role === "assistant"
    )
    expect(assistantsBefore.length).toBe(0)
  })
})

describe("Session.cancel", () => {
  it("returns 'cancelled' when the abort fires during streaming", async () => {
    const claude: ClaudeClient = {
      async *stream(req: ClaudeStreamRequest) {
        // Yield one chunk, then wait for abort, then throw.
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } as never }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } as never }
        await new Promise<void>((_resolve, reject) => {
          if (req.signal) {
            req.signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            })
          }
        })
      },
    }

    const session = new Session(
      "s2",
      "/tmp",
      {
        sessionId: "s2",
        notify: () => {},
        request: () => Promise.reject(new Error("no")),
      },
      { defaultModel: "claude-sonnet-4-6", models: ["claude-sonnet-4-6"], claude }
    )

    const promise = session.prompt([{ type: "text", text: "hi" }])
    setTimeout(() => session.cancel(), 5)
    const reason = await promise
    expect(reason).toBe("cancelled")
  })
})
