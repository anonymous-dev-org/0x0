import { describe, expect, test, mock, beforeEach } from "bun:test"
import type { CompletionEvent } from "../src/provider/sdk/claude-code"

// ─── Mock completionStream ──────────────────────────────────────────────────

type StreamCall = {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
}
const streamCalls: StreamCall[] = []
let mockEvents: CompletionEvent[] = []

mock.module("../src/provider/sdk/claude-code", () => ({
  completionStream: async function* (input: StreamCall) {
    streamCalls.push(input)
    for (const event of mockEvents) {
      yield event
    }
  },
}))

mock.module("../src/provider/sdk/codex", () => ({
  completionStream: async function* (input: StreamCall) {
    streamCalls.push(input)
    for (const event of mockEvents) {
      yield event
    }
  },
}))

// Mock provider to always return claude
mock.module("../src/provider/provider", () => ({
  Provider: {
    defaultProvider: async () => "claude",
    all: () => ({}),
    list: async () => ({}),
    getModel: async () => ({}),
    ModelNotFoundError: { isInstance: () => false },
  },
}))

// Import after mocking
const { Server } = await import("../src/server/server")

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseSSE(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("completion routes", () => {
  beforeEach(() => {
    streamCalls.length = 0
    mockEvents = []
  })

  test("POST /completion sends prefix+suffix context and streams deltas", async () => {
    mockEvents = [
      { type: "delta", text: "console.log" },
      { type: "delta", text: '("hello")' },
      { type: "done" },
    ]

    const app = Server.App()
    const response = await app.request("/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: "function greet() {\n  ",
        suffix: "\n}",
        language: "typescript",
        filename: "src/greet.ts",
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const body = await response.text()
    const events = parseSSE(body) as CompletionEvent[]

    expect(events).toEqual([
      { type: "delta", text: "console.log" },
      { type: "delta", text: '("hello")' },
      { type: "done" },
    ])

    expect(streamCalls).toHaveLength(1)
    const call = streamCalls[0]!
    expect(call.prompt).toContain("<code_before_cursor>")
    expect(call.prompt).toContain("function greet() {\n  ")
    expect(call.prompt).toContain("</code_before_cursor>")
    expect(call.prompt).toContain("<code_after_cursor>")
    expect(call.prompt).toContain("\n}")
    expect(call.prompt).toContain("</code_after_cursor>")
    expect(call.prompt).toContain("Language: typescript")
    expect(call.prompt).toContain("File: src/greet.ts")

    expect(call.systemPrompt).toContain("code completion engine")
    expect(call.stopSequences).toEqual(["\n\n\n"])
  })

  test("POST /completion uses default model when none specified", async () => {
    mockEvents = [{ type: "done" }]

    const app = Server.App()
    await app.request("/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: "x",
        suffix: "",
      }),
    })

    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]!.model).toBe("claude-haiku-4-5-20251001")
  })

  test("POST /completion uses custom model when specified", async () => {
    mockEvents = [{ type: "done" }]

    const app = Server.App()
    await app.request("/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: "x",
        suffix: "",
        model: "claude-sonnet-4-6",
      }),
    })

    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]!.model).toBe("claude-sonnet-4-6")
  })

  test("POST /completion returns 400 for missing prefix", async () => {
    const app = Server.App()
    const response = await app.request("/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suffix: "}" }),
    })

    expect(response.status).toBe(400)
    expect(streamCalls).toHaveLength(0)
  })

  test("POST /completion/text streams text generation", async () => {
    mockEvents = [
      { type: "delta", text: "The answer is " },
      { type: "delta", text: "42." },
      { type: "done" },
    ]

    const app = Server.App()
    const response = await app.request("/completion/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "What is the meaning of life?",
        system: "You are a philosopher.",
      }),
    })

    expect(response.status).toBe(200)

    const body = await response.text()
    const events = parseSSE(body) as CompletionEvent[]

    expect(events).toEqual([
      { type: "delta", text: "The answer is " },
      { type: "delta", text: "42." },
      { type: "done" },
    ])

    expect(streamCalls).toHaveLength(1)
    const call = streamCalls[0]!
    expect(call.prompt).toBe("What is the meaning of life?")
    expect(call.systemPrompt).toBe("You are a philosopher.")
    expect(call.model).toBe("claude-haiku-4-5-20251001")
    expect(call.stopSequences).toBeUndefined()
  })

  test("GET /health returns ok", async () => {
    const app = Server.App()
    const response = await app.request("/health")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true })
  })

  test("POST /completion/accept stores accepted completion", async () => {
    const app = Server.App()
    const response = await app.request("/completion/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "typescript",
        filename: "test.ts",
        prefix: "const x = ",
        accepted: "42",
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true })
  })

  test("GET /completion/memory/stats returns stats", async () => {
    const app = Server.App()
    const response = await app.request("/completion/memory/stats")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty("total_accepts")
    expect(body).toHaveProperty("total_rejects")
    expect(body).toHaveProperty("learned_rules")
    expect(body).toHaveProperty("acceptance_rate")
    expect(body).toHaveProperty("by_language")
    expect(body).toHaveProperty("by_category")
  })

  test("POST /completion/reject stores rejected completion", async () => {
    const app = Server.App()
    const response = await app.request("/completion/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "typescript",
        prefix: "const x = ",
        suggested: "null",
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true })
  })

  test("DELETE /completion/memory clears memory", async () => {
    const app = Server.App()
    const response = await app.request("/completion/memory", {
      method: "DELETE",
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true })
  })

  test("POST /completion streams error events from completionStream", async () => {
    mockEvents = [
      { type: "delta", text: "partial" },
      { type: "error", error: "API rate limit exceeded" },
    ]

    const app = Server.App()
    const response = await app.request("/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: "let x = ",
        suffix: "",
        language: "javascript",
      }),
    })

    expect(response.status).toBe(200)

    const body = await response.text()
    const events = parseSSE(body) as CompletionEvent[]

    expect(events).toEqual([
      { type: "delta", text: "partial" },
      { type: "error", error: "API rate limit exceeded" },
    ])
  })
})
