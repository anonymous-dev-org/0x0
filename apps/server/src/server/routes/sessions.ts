import { Hono } from "hono"
import { SessionStore } from "@/session/store"
import { SessionNotFoundError } from "../error"

export function SessionRoutes() {
  return new Hono()
    .get("/", (c) => {
      const sessions = SessionStore.list().map((s) => ({
        id: s.id,
        provider: s.provider,
        status: s.status,
        created_at: s.createdAt.toISOString(),
        last_active_at: s.lastActiveAt.toISOString(),
        message_count: s.messageCount,
      }))
      return c.json({ sessions })
    })
    .get("/:id", (c) => {
      const session = SessionStore.get(c.req.param("id"))
      if (!session) throw new SessionNotFoundError({ id: c.req.param("id") })
      return c.json({
        id: session.id,
        provider: session.provider,
        status: session.status,
        created_at: session.createdAt.toISOString(),
        last_active_at: session.lastActiveAt.toISOString(),
        message_count: session.messageCount,
      })
    })
    .delete("/:id", (c) => {
      const id = c.req.param("id")
      const removed = SessionStore.remove(id)
      if (!removed) throw new SessionNotFoundError({ id })
      return c.json({ ok: true })
    })
}
