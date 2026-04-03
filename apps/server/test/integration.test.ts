import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Server } from "@/server/server"

/**
 * Integration tests that exercise real Claude and Codex CLIs.
 * These tests make actual API calls and cost real tokens.
 * They are skipped if the respective CLI is not installed.
 */

let server: ReturnType<typeof Server.listen>
const port = 14097

beforeAll(() => {
  server = Server.listen({ port, hostname: "127.0.0.1" })
})

afterAll(async () => {
  await server.stop()
})

const base = `http://127.0.0.1:${port}`

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function parseSSE(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>
}

const claudeAvailable = Bun.which("claude") !== null
const codexAvailable = Bun.which("codex") !== null

describe("claude integration", () => {
  const describeOrSkip = claudeAvailable ? describe : describe.skip

  describeOrSkip("streaming", () => {
    it("streams SSE events for a simple prompt", async () => {
      const res = await post("/messages", {
        prompt: 'Respond with exactly: "pong"',
        provider: "claude",
        max_turns: 1,
        permission_mode: "plan",
        stream: true,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const events = await parseSSE(res)
      expect(events.length).toBeGreaterThan(0)

      const types = events.map((e) => e.type)
      expect(types).toContain("init")
      expect(types).toContain("done")

      // Should have at least one text delta
      const textDeltas = events.filter((e) => e.type === "text_delta")
      expect(textDeltas.length).toBeGreaterThan(0)

      // init event should include session_id
      const init = events.find((e) => e.type === "init")
      expect(init?.session_id).toBeDefined()
    }, 30000)

    it("returns result event with metadata", async () => {
      const res = await post("/messages", {
        prompt: 'Say "ok"',
        provider: "claude",
        max_turns: 1,
        permission_mode: "plan",
        stream: true,
      })

      const events = await parseSSE(res)
      const result = events.find((e) => e.type === "result")
      expect(result).toBeDefined()
      expect(result?.duration_ms).toBeGreaterThan(0)
    }, 30000)
  })

  describeOrSkip("non-streaming", () => {
    it("returns JSON result for a simple prompt", async () => {
      const res = await post("/messages", {
        prompt: 'Respond with exactly: "hello"',
        provider: "claude",
        max_turns: 1,
        permission_mode: "plan",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty("session_id")
      expect(body).toHaveProperty("result")
      expect(typeof body.result).toBe("string")
      expect(body.result.length).toBeGreaterThan(0)
    }, 30000)
  })

  describeOrSkip("session continuity", () => {
    it("creates a session and can query it", async () => {
      const res = await post("/messages", {
        prompt: 'Say "test"',
        provider: "claude",
        max_turns: 1,
        permission_mode: "plan",
        stream: false,
      })
      const body = await res.json()
      expect(body.session_id).toBeDefined()

      // Session should be listed
      const sessionsRes = await fetch(`${base}/sessions`)
      const sessions = await sessionsRes.json()
      const found = sessions.sessions.find(
        (s: { id: string }) => s.id === body.session_id,
      )
      expect(found).toBeDefined()
      expect(found.provider).toBe("claude")
      expect(found.status).toBe("idle")
      expect(found.message_count).toBe(1)

      // Session details
      const detailRes = await fetch(`${base}/sessions/${body.session_id}`)
      const detail = await detailRes.json()
      expect(detail.id).toBe(body.session_id)

      // Delete session
      const delRes = await fetch(`${base}/sessions/${body.session_id}`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
    }, 30000)
  })

  describeOrSkip("options passthrough", () => {
    it("respects system_prompt", async () => {
      const res = await post("/messages", {
        prompt: "What are you?",
        provider: "claude",
        system_prompt: "You are a pirate. Always start your response with 'Arrr'.",
        max_turns: 1,
        permission_mode: "plan",
        stream: false,
      })
      const body = await res.json()
      expect(body.result.toLowerCase()).toContain("arrr")
    }, 30000)

    it("respects max_turns", async () => {
      const res = await post("/messages", {
        prompt: 'Say "done"',
        provider: "claude",
        max_turns: 1,
        permission_mode: "plan",
        stream: false,
      })
      expect(res.status).toBe(200)
    }, 30000)
  })
})

describe("codex integration", () => {
  const describeOrSkip = codexAvailable ? describe : describe.skip

  describeOrSkip("streaming", () => {
    it("streams SSE events for a simple prompt", async () => {
      const res = await post("/messages", {
        prompt: 'Respond with exactly: "pong"',
        provider: "codex",
        sandbox: "read-only",
        stream: true,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const events = await parseSSE(res)
      expect(events.length).toBeGreaterThan(0)

      const types = events.map((e) => e.type)
      expect(types).toContain("init")
      expect(types).toContain("done")
    }, 60000)
  })

  describeOrSkip("non-streaming", () => {
    it("returns JSON result for a simple prompt", async () => {
      const res = await post("/messages", {
        prompt: 'Respond with exactly: "hello"',
        provider: "codex",
        sandbox: "read-only",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty("session_id")
      expect(body).toHaveProperty("result")
    }, 60000)
  })
})

describe("provider auto-detection", () => {
  it("auto-selects a provider when none specified", async () => {
    const res = await post("/messages", {
      prompt: 'Say "auto"',
      max_turns: 1,
      permission_mode: "plan",
      stream: false,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session_id).toBeDefined()
    expect(body.result.length).toBeGreaterThan(0)
  }, 30000)
})
