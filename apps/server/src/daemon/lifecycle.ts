import path from "path"
import { PidFile } from "./pid"
import { Global } from "@/core/global"

export namespace Daemon {
  export async function status(): Promise<{ running: boolean; pid?: number; port?: number }> {
    const info = await PidFile.read()
    if (!info) return { running: false }
    if (!PidFile.isRunning(info.pid)) {
      await PidFile.remove()
      return { running: false }
    }

    // Verify via health check
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return { running: true, pid: info.pid, port: info.port }
    } catch {}

    // Process alive but not responding — stale
    return { running: true, pid: info.pid, port: info.port }
  }

  export async function start(opts: { port: number; hostname: string }): Promise<{ pid: number; port: number }> {
    const current = await status()
    if (current.running) {
      return { pid: current.pid!, port: current.port! }
    }

    const entrypoint = path.resolve(import.meta.dir, "../index.ts")
    const logFile = path.join(Global.Path.log, "daemon.log")

    const proc = Bun.spawn(
      ["bun", "run", entrypoint, "serve", "--port", String(opts.port), "--hostname", opts.hostname],
      {
        stdout: Bun.file(logFile),
        stderr: Bun.file(logFile),
        stdin: "ignore",
        env: { ...process.env, ZEROXZERO_DAEMON: "1" },
      },
    )

    // Detach from parent
    proc.unref()

    const port = opts.port || 4096

    // Poll health check to confirm startup
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        })
        if (res.ok) {
          await PidFile.write({ pid: proc.pid, port })
          return { pid: proc.pid, port }
        }
      } catch {}
    }

    throw new Error("Daemon failed to start within 3 seconds. Check logs at " + logFile)
  }

  export async function stop(): Promise<boolean> {
    const info = await PidFile.read()
    if (!info) return false

    if (PidFile.isRunning(info.pid)) {
      process.kill(info.pid, "SIGTERM")
      // Wait for process to exit
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(100)
        if (!PidFile.isRunning(info.pid)) break
      }
    }

    await PidFile.remove()
    return true
  }
}
