import { Global } from "@anonymous-dev/0x0-server/global"
import { Log } from "@anonymous-dev/0x0-server/util/log"
import path from "path"
import fs from "fs/promises"

const DEFAULT_PORT = 4096
const LOCK_PATH = path.join(Global.Path.state, "server.lock")
const HEALTH_ENDPOINT = "/doc"
const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 10_000

export namespace Daemon {
  interface LockFile {
    pid: number
    port: number
    url: string
  }

  export async function discover(opts?: {
    port?: number
    hostname?: string
  }): Promise<{ url: string } | null> {
    try {
      const host = opts?.hostname ?? "127.0.0.1"
      const port = opts?.port ?? DEFAULT_PORT
      const url = `http://${host}:${port}`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 500)
      try {
        const response = await fetch(`${url}${HEALTH_ENDPOINT}`, {
          signal: controller.signal,
        })
        if (response.ok) {
          return { url }
        }
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      // Server not reachable
    }
    return null
  }

  export async function start(opts?: {
    port?: number
    hostname?: string
  }): Promise<{ url: string }> {
    const existing = await discover(opts)
    if (existing) return existing

    const log = Log.create({ service: "daemon" })
    log.info("starting server daemon")

    const logDir = Global.Path.log
    const logFile = path.join(logDir, "server.log")

    const port = opts?.port ?? DEFAULT_PORT
    const hostname = opts?.hostname ?? "127.0.0.1"

    const args = ["0x0-server", "--port", String(port)]
    if (opts?.hostname) {
      args.push("--hostname", hostname)
    }

    const proc = Bun.spawn(args, {
      stdio: ["ignore", Bun.file(logFile), Bun.file(logFile)],
      env: {
        ...process.env,
      },
    })
    proc.unref()

    const lockData: LockFile = {
      pid: proc.pid,
      port,
      url: `http://${hostname}:${port}`,
    }

    await fs.writeFile(LOCK_PATH, JSON.stringify(lockData, null, 2))

    // Poll until server is ready
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const result = await discover(opts)
      if (result) {
        log.info("server daemon ready", { url: result.url })
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    throw new Error(`Server daemon failed to start within ${POLL_TIMEOUT_MS}ms. Check ${logFile} for details.`)
  }

  export async function stop(): Promise<void> {
    try {
      const raw = await fs.readFile(LOCK_PATH, "utf-8")
      const lock: LockFile = JSON.parse(raw)
      try {
        process.kill(lock.pid, "SIGTERM")
      } catch {
        // Process may already be dead
      }
    } catch {
      // No lock file or invalid — nothing to stop
    }

    try {
      await fs.unlink(LOCK_PATH)
    } catch {
      // Already gone
    }
  }
}
