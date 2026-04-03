import { describe, it, expect, beforeEach } from "bun:test"
import { SessionStore } from "@/session/store"

describe("SessionStore", () => {
  beforeEach(() => {
    // Clean up all sessions
    for (const s of SessionStore.list()) {
      SessionStore.remove(s.id)
    }
  })

  it("create() makes a new session", () => {
    const session = SessionStore.create("claude")
    expect(session.id).toBeDefined()
    expect(session.provider).toBe("claude")
    expect(session.status).toBe("idle")
    expect(session.messageCount).toBe(0)
  })

  it("get() returns the session", () => {
    const session = SessionStore.create("codex")
    const found = SessionStore.get(session.id)
    expect(found).toBeDefined()
    expect(found!.id).toBe(session.id)
  })

  it("get() returns undefined for unknown id", () => {
    expect(SessionStore.get("nonexistent")).toBeUndefined()
  })

  it("list() returns all sessions", () => {
    SessionStore.create("claude")
    SessionStore.create("codex")
    expect(SessionStore.list().length).toBe(2)
  })

  it("remove() deletes a session", () => {
    const session = SessionStore.create("claude")
    expect(SessionStore.remove(session.id)).toBe(true)
    expect(SessionStore.get(session.id)).toBeUndefined()
  })

  it("remove() returns false for unknown id", () => {
    expect(SessionStore.remove("nonexistent")).toBe(false)
  })

  it("setBusy/setIdle transitions status", () => {
    const session = SessionStore.create("claude")
    SessionStore.setBusy(session.id)
    expect(SessionStore.get(session.id)!.status).toBe("busy")

    SessionStore.setIdle(session.id, "provider-session-123")
    const updated = SessionStore.get(session.id)!
    expect(updated.status).toBe("idle")
    expect(updated.providerSessionId).toBe("provider-session-123")
    expect(updated.messageCount).toBe(1)
  })

  it("count() returns session count", () => {
    expect(SessionStore.count()).toBe(0)
    SessionStore.create("claude")
    expect(SessionStore.count()).toBe(1)
  })

  it("cleanup() removes expired idle sessions", () => {
    const session = SessionStore.create("claude")
    // Manually backdate the session
    const s = SessionStore.get(session.id)!
    s.lastActiveAt = new Date(Date.now() - 120 * 60 * 1000) // 2 hours ago

    SessionStore.cleanup(60) // TTL 60 minutes
    expect(SessionStore.get(session.id)).toBeUndefined()
  })

  it("cleanup() keeps busy sessions", () => {
    const session = SessionStore.create("claude")
    SessionStore.setBusy(session.id)
    const s = SessionStore.get(session.id)!
    s.lastActiveAt = new Date(Date.now() - 120 * 60 * 1000)

    SessionStore.cleanup(60)
    expect(SessionStore.get(session.id)).toBeDefined()
  })
})
