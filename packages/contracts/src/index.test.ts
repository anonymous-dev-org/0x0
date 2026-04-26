import { describe, expect, test } from "bun:test"
import {
  ChatRequestSchema,
  ProvidersResponseSchema,
  WebSocketClientMessageSchema,
  WebSocketServerMessageSchema,
} from "./index"

describe("contracts", () => {
  test("parses core chat and provider payloads", () => {
    expect(
      ChatRequestSchema.parse({
        provider: "codex",
        model: "gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
      }).stream
    ).toBe(true)

    expect(
      ProvidersResponseSchema.parse({
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModel: "gpt-5.3-codex",
            models: ["gpt-5.3-codex"],
            configured: true,
          },
        ],
      }).providers
    ).toHaveLength(1)
  })

  test("parses websocket envelopes", () => {
    expect(WebSocketClientMessageSchema.parse({ type: "ping", id: "1" }).type).toBe("ping")
    expect(WebSocketServerMessageSchema.parse({ type: "pong", id: "1" }).type).toBe("pong")
    expect(
      WebSocketServerMessageSchema.parse({
        type: "session.created",
        id: "1",
        session: {
          id: "session-1",
          repoRoot: "/repo",
          provider: "codex",
          model: "test-model",
          createdAt: "2026-04-25T00:00:00.000Z",
          messages: [{ role: "user", content: "hello" }],
        },
      }).type
    ).toBe("session.created")
    expect(
      WebSocketServerMessageSchema.parse({
        type: "user.queued",
        id: "2",
        sessionId: "session-1",
        messages: [{ role: "user", content: "queued" }],
      }).type
    ).toBe("user.queued")
  })
})
