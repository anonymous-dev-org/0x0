import { Log } from "@/util/log"

const log = Log.create({ service: "session" })

export interface Session {
  id: string
  provider: string
  providerSessionId?: string
  status: "idle" | "busy"
  createdAt: Date
  lastActiveAt: Date
  messageCount: number
}

export interface WorkgroupAgent {
  name: string
  sessionId: string
  provider: string
  model?: string
  status: "idle" | "busy"
  lastResponse?: string
}

export interface WorkgroupState {
  id: string
  agents: Map<string, WorkgroupAgent>
  createdAt: Date
}

const sessions = new Map<string, Session>()
const workgroups = new Map<string, WorkgroupState>()

export namespace SessionStore {
  export function create(provider: string): Session {
    const id = crypto.randomUUID()
    const session: Session = {
      id,
      provider,
      status: "idle",
      createdAt: new Date(),
      lastActiveAt: new Date(),
      messageCount: 0,
    }
    sessions.set(id, session)
    log.info("created", { id, provider })
    return session
  }

  export function get(id: string): Session | undefined {
    return sessions.get(id)
  }

  export function list(): Session[] {
    return Array.from(sessions.values())
  }

  export function remove(id: string): boolean {
    const removed = sessions.delete(id)
    if (removed) log.info("removed", { id })
    return removed
  }

  export function setBusy(id: string): void {
    const session = sessions.get(id)
    if (!session) return
    session.status = "busy"
    session.lastActiveAt = new Date()
  }

  export function setIdle(id: string, providerSessionId?: string): void {
    const session = sessions.get(id)
    if (!session) return
    session.status = "idle"
    session.lastActiveAt = new Date()
    session.messageCount++
    if (providerSessionId) session.providerSessionId = providerSessionId
  }

  export function count(): number {
    return sessions.size
  }

  export function cleanup(ttlMinutes: number): void {
    const now = Date.now()
    const ttlMs = ttlMinutes * 60 * 1000
    for (const [id, session] of sessions) {
      if (session.status === "idle" && now - session.lastActiveAt.getTime() > ttlMs) {
        sessions.delete(id)
        log.info("expired", { id })
      }
    }
    // Also clean up workgroups whose sessions have all expired
    for (const [id, wg] of workgroups) {
      const allExpired = Array.from(wg.agents.values()).every(
        (a) => !sessions.has(a.sessionId),
      )
      if (allExpired) {
        workgroups.delete(id)
        log.info("workgroup expired", { id })
      }
    }
  }

  // Workgroup management

  export function createWorkgroup(): WorkgroupState {
    const id = crypto.randomUUID()
    const wg: WorkgroupState = {
      id,
      agents: new Map(),
      createdAt: new Date(),
    }
    workgroups.set(id, wg)
    log.info("workgroup created", { id })
    return wg
  }

  export function getWorkgroup(id: string): WorkgroupState | undefined {
    return workgroups.get(id)
  }

  export function addWorkgroupAgent(
    workgroupId: string,
    agent: WorkgroupAgent,
  ): void {
    const wg = workgroups.get(workgroupId)
    if (!wg) return
    wg.agents.set(agent.name, agent)
  }

  export function removeWorkgroup(id: string): boolean {
    const wg = workgroups.get(id)
    if (!wg) return false
    // Clean up all agent sessions
    for (const agent of wg.agents.values()) {
      sessions.delete(agent.sessionId)
    }
    workgroups.delete(id)
    log.info("workgroup closed", { id })
    return true
  }
}
