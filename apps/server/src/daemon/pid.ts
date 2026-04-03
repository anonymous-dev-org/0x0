import path from "path"
import fs from "fs/promises"
import { Global } from "@/core/global"

const pidFile = () => path.join(Global.Path.state, "server.pid")

export interface PidInfo {
  pid: number
  port: number
}

export namespace PidFile {
  export async function write(info: PidInfo): Promise<void> {
    await Bun.write(pidFile(), JSON.stringify(info))
  }

  export async function read(): Promise<PidInfo | undefined> {
    try {
      const text = await Bun.file(pidFile()).text()
      return JSON.parse(text) as PidInfo
    } catch {
      return undefined
    }
  }

  export async function remove(): Promise<void> {
    try {
      await fs.unlink(pidFile())
    } catch {}
  }

  export function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
