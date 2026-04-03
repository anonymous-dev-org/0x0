import { describe, it, expect, beforeAll, beforeEach } from "bun:test"
import { Server } from "@/server/server"
import { SessionStore } from "@/session/store"

let app: ReturnType<typeof Server.App>

beforeAll(() => {
  app = Server.App()
})

beforeEach(() => {
  // Clean sessions between tests
  for (const s of SessionStore.list()) {
    SessionStore.remove(s.id)
  }
})

function post(path: string, body: unknown) {
  return app.request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function get(path: string) {
  return app.request(`http://test${path}`)
}

function del(path: string) {
  return app.request(`http://test${path}`, { method: "DELETE" })
}

// --- Health ---

describe("health", () => {
  it("GET /health returns ok with session count", async () => {
    const res = await get("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.sessions).toBe("number")
  })

  it("GET /health reflects session count", async () => {
    SessionStore.create("claude")
    SessionStore.create("codex")
    const res = await get("/health")
    const body = await res.json()
    expect(body.sessions).toBe(2)
  })
})

// --- Providers ---

describe("providers", () => {
  it("GET /providers returns provider list with schemas", async () => {
    const res = await get("/providers")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.providers)).toBe(true)
    for (const p of body.providers) {
      expect(p).toHaveProperty("id")
      expect(p).toHaveProperty("name")
      expect(Array.isArray(p.supported_options)).toBe(true)
      expect(p).toHaveProperty("input_schema")
      expect(p.input_schema.type).toBe("object")
      expect(p.input_schema.required).toContain("prompt")
      expect(p.input_schema.properties).toHaveProperty("prompt")
      expect(p).toHaveProperty("defaults")
    }
  })

  it("claude provider includes claude-specific options", async () => {
    const res = await get("/providers")
    const body = await res.json()
    const claude = body.providers.find((p: { id: string }) => p.id === "claude")
    if (!claude) return // skip if not available
    expect(claude.supported_options).toContain("system_prompt")
    expect(claude.supported_options).toContain("permission_mode")
    expect(claude.supported_options).toContain("allowed_tools")
    expect(claude.input_schema.properties).toHaveProperty("system_prompt")
    expect(claude.input_schema.properties).toHaveProperty("permission_mode")
  })

  it("codex provider includes codex-specific options", async () => {
    const res = await get("/providers")
    const body = await res.json()
    const codex = body.providers.find((p: { id: string }) => p.id === "codex")
    if (!codex) return
    expect(codex.supported_options).toContain("sandbox")
    expect(codex.input_schema.properties).toHaveProperty("sandbox")
  })
})

// --- Sessions ---

describe("sessions", () => {
  it("GET /sessions returns empty list initially", async () => {
    const res = await get("/sessions")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toEqual([])
  })

  it("GET /sessions/:id returns 404 for unknown session", async () => {
    const res = await get("/sessions/00000000-0000-0000-0000-000000000000")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.name).toBe("SessionNotFoundError")
  })

  it("DELETE /sessions/:id returns 404 for unknown session", async () => {
    const res = await del("/sessions/00000000-0000-0000-0000-000000000000")
    expect(res.status).toBe(404)
  })

  it("GET /sessions/:id returns session details", async () => {
    const session = SessionStore.create("claude")
    const res = await get(`/sessions/${session.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(session.id)
    expect(body.provider).toBe("claude")
    expect(body.status).toBe("idle")
    expect(body.message_count).toBe(0)
    expect(body).toHaveProperty("created_at")
    expect(body).toHaveProperty("last_active_at")
  })

  it("DELETE /sessions/:id removes the session", async () => {
    const session = SessionStore.create("claude")
    const delRes = await del(`/sessions/${session.id}`)
    expect(delRes.status).toBe(200)
    const body = await delRes.json()
    expect(body.ok).toBe(true)

    // Verify it's gone
    const getRes = await get(`/sessions/${session.id}`)
    expect(getRes.status).toBe(404)
  })

  it("GET /sessions lists all sessions", async () => {
    SessionStore.create("claude")
    SessionStore.create("codex")
    const res = await get("/sessions")
    const body = await res.json()
    expect(body.sessions.length).toBe(2)
    const providers = body.sessions.map((s: { provider: string }) => s.provider).sort()
    expect(providers).toEqual(["claude", "codex"])
  })

  it("session response includes expected fields", async () => {
    SessionStore.create("claude")
    const res = await get("/sessions")
    const body = await res.json()
    const session = body.sessions[0]
    expect(session).toHaveProperty("id")
    expect(session).toHaveProperty("provider")
    expect(session).toHaveProperty("status")
    expect(session).toHaveProperty("created_at")
    expect(session).toHaveProperty("last_active_at")
    expect(session).toHaveProperty("message_count")
  })
})

// --- Messages validation ---

describe("messages validation", () => {
  it("rejects empty prompt", async () => {
    const res = await post("/messages", { prompt: "" })
    expect(res.status).toBe(400)
  })

  it("rejects missing prompt", async () => {
    const res = await post("/messages", {})
    expect(res.status).toBe(400)
  })

  it("rejects invalid session_id (not uuid)", async () => {
    const res = await post("/messages", { prompt: "test", session_id: "not-a-uuid" })
    expect(res.status).toBe(400)
  })

  it("rejects unknown session_id", async () => {
    const res = await post("/messages", {
      prompt: "test",
      session_id: "00000000-0000-0000-0000-000000000000",
    })
    expect(res.status).toBe(404)
  })

  it("rejects unsupported provider options (sandbox on claude)", async () => {
    const providersRes = await get("/providers")
    const providersBody = await providersRes.json() as { providers: Array<{ id: string }> }
    const claude = providersBody.providers.find((p) => p.id === "claude")
    if (!claude) return

    const res = await post("/messages", {
      prompt: "test",
      provider: "claude",
      sandbox: "workspace-write",
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.name).toBe("UnsupportedProviderOptionsError")
  })

  it("rejects unsupported provider options (system_prompt on codex)", async () => {
    const providersRes = await get("/providers")
    const providersBody = await providersRes.json() as { providers: Array<{ id: string }> }
    const codex = providersBody.providers.find((p) => p.id === "codex")
    if (!codex) return

    const res = await post("/messages", {
      prompt: "test",
      provider: "codex",
      system_prompt: "be concise",
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.name).toBe("UnsupportedProviderOptionsError")
    expect(body.data.options).toContain("system_prompt")
    expect(body.data.supported_options).toContain("prompt")
  })

  it("rejects negative max_turns", async () => {
    const res = await post("/messages", { prompt: "test", max_turns: -1 })
    expect(res.status).toBe(400)
  })

  it("rejects non-integer max_turns", async () => {
    const res = await post("/messages", { prompt: "test", max_turns: 1.5 })
    expect(res.status).toBe(400)
  })

  it("rejects unknown body fields (strict schema)", async () => {
    const res = await post("/messages", { prompt: "test", unknown_field: "value" })
    expect(res.status).toBe(400)
  })

  it("rejects unknown provider", async () => {
    const res = await post("/messages", { prompt: "test", provider: "gemini" })
    expect(res.status).toBe(500) // Error from ProviderRegistry.resolve
  })

  it("accepts valid claude options", async () => {
    // This will actually try to spawn claude, so we just check it doesn't
    // fail validation (it may fail/succeed at spawn level)
    const res = await post("/messages", {
      prompt: "say hi",
      provider: "claude",
      model: "claude-sonnet-4-6",
      system_prompt: "be brief",
      permission_mode: "plan",
      max_turns: 1,
      stream: false,
    })
    // Should not be 400 (validation error) — may be 200 or 500 (spawn error)
    expect(res.status).not.toBe(400)
  })
})

// --- Trailing slash handling ---

describe("trailing slash", () => {
  it("GET /health/ redirects to /health", async () => {
    const res = await get("/health/")
    // trimTrailingSlash middleware should redirect or handle
    expect([200, 301, 302]).toContain(res.status)
  })
})
