import { describe, expect, it } from "bun:test"
import type { ChatProvider } from "./providers/types"
import { createApp } from "./app"
import type { ChatRequest, ChatResponse, ChatStreamEvent } from "@anonymous-dev/0x0-contracts"

function fakeProvider(id: "codex" | "claude", configured = true): ChatProvider {
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
      yield { type: "start", provider: id, model: input.model }
      yield { type: "text_delta", text: "hello" }
      yield { type: "done", provider: id, model: input.model, text: "hello" }
    },
    async complete(input: ChatRequest): Promise<ChatResponse> {
      return {
        provider: id,
        model: input.model,
        text: "hello",
      }
    },
  }
}

describe("server app", () => {
  const app = createApp({
    codex: fakeProvider("codex"),
    claude: fakeProvider("claude", false),
  })

  it("lists providers", async () => {
    const res = await app.request("/providers")
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.providers).toHaveLength(2)
    expect(json.providers[0].id).toBe("codex")
  })

  it("returns a non-streaming response", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.text).toBe("hello")
  })

  it("rejects unavailable providers", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(400)
  })

  it("returns one-shot inline completions", async () => {
    const res = await app.request("/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prefix: "const value = ",
        suffix: "",
        language: "typescript",
        filepath: "example.ts",
        provider: "codex",
        model: "test-model",
      }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      provider: "codex",
      model: "test-model",
      text: "hello",
    })
  })

  it("returns one-shot inline edits", async () => {
    const res = await app.request("/inline-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "example.ts",
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 12 },
        prompt: "make this const safer",
        text: "let value = 1",
        provider: "codex",
        model: "test-model",
      }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ replacementText: "hello" })
  })
})
