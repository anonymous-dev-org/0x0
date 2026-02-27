import { Bus } from "@/core/bus"
import { Instance } from "@/project/instance"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"

export namespace Caffeinate {
  const log = Log.create({ service: "caffeinate" })
  const isMacOS = process.platform === "darwin"

  /** Maximum caffeinate duration (4 hours). Safety net against missed idle events. */
  const MAX_DURATION_MS = 4 * 60 * 60 * 1000

  interface Holder {
    sessionID: string
    acquiredAt: number
  }

  interface State {
    holders: Map<string, Holder>
    process: ReturnType<typeof Bun.spawn> | undefined
    unsubscribe: (() => void) | undefined
    healthCheck: ReturnType<typeof setInterval> | undefined
  }

  const state = Instance.state(
    (): State => {
      const s: State = {
        holders: new Map(),
        process: undefined,
        unsubscribe: undefined,
        healthCheck: undefined,
      }

      s.unsubscribe = Bus.subscribe(SessionStatus.Event.Status, (event) => {
        try {
          const { sessionID, status } = event.properties
          if (status.type === "idle" && s.holders.has(sessionID)) {
            log.info("auto-releasing on idle", { sessionID })
            release(sessionID)
          }
        } catch (e) {
          log.error("error in caffeinate bus callback", { error: String(e) })
        }
      })

      // Periodic health check: expire holders that exceeded MAX_DURATION_MS
      s.healthCheck = setInterval(() => {
        const now = Date.now()
        for (const [sessionID, holder] of s.holders) {
          if (now - holder.acquiredAt > MAX_DURATION_MS) {
            log.info("force-releasing caffeinate (max duration exceeded)", { sessionID })
            release(sessionID)
          }
        }
      }, 60_000)

      return s
    },
    async (s) => {
      s.unsubscribe?.()
      if (s.healthCheck) clearInterval(s.healthCheck)
      s.holders.clear()
      killProcess(s)
    },
  )

  function killProcess(s: State) {
    if (!s.process) return
    log.info("killing caffeinate process")
    try {
      s.process.kill()
    } catch {}
    s.process = undefined
  }

  function ensureProcess(s: State) {
    if (s.process) return
    const pid = process.pid
    log.info("spawning caffeinate -s -w " + pid)
    // -s: prevent system sleep
    // -w PID: auto-exit when our process dies (safety net against orphaned processes)
    s.process = Bun.spawn(["caffeinate", "-s", "-w", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    })
    s.process.exited.then(() => {
      s.process = undefined
      if (s.holders.size > 0) {
        log.info("caffeinate exited unexpectedly, respawning")
        ensureProcess(s)
      }
    })
  }

  export function acquire(sessionID: string): boolean {
    if (!isMacOS) return false
    const s = state()
    if (s.holders.has(sessionID)) return false
    s.holders.set(sessionID, { sessionID, acquiredAt: Date.now() })
    log.info("acquired", { sessionID, count: s.holders.size })
    ensureProcess(s)
    return true
  }

  export function release(sessionID: string): boolean {
    if (!isMacOS) return false
    const s = state()
    if (!s.holders.delete(sessionID)) return false
    log.info("released", { sessionID, count: s.holders.size })
    if (s.holders.size === 0) killProcess(s)
    return true
  }

  export function toggle(sessionID: string): boolean {
    if (!isMacOS) return false
    const s = state()
    if (s.holders.has(sessionID)) {
      release(sessionID)
      return false
    }
    acquire(sessionID)
    return true
  }

  export function isActive(sessionID: string): boolean {
    if (!isMacOS) return false
    return state().holders.has(sessionID)
  }
}
