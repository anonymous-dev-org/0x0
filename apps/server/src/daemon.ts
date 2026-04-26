import { spawn } from "node:child_process"
import { existsSync, openSync } from "node:fs"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { ensureConfigDir, ensureParentDir, LOG_PATH, mergeProviderEnv, PID_PATH, type ServerConfig } from "./config"

export type ServerAddress = {
  hostname?: string
  port?: number
}

export type ServerStatus =
  | { running: true; url: string; pid?: number }
  | { running: false; url: string; pid?: number }

export function resolvePort(port?: number) {
  return port ?? Number(process.env.PORT ?? 4096)
}

export function resolveHostname(hostname?: string) {
  return hostname ?? "127.0.0.1"
}

export function serverUrl(options: ServerAddress = {}) {
  return `http://${resolveHostname(options.hostname)}:${resolvePort(options.port)}`
}

function cliCommand(args: string[]) {
  const runtime = process.execPath
  const script = Bun.argv[1]
  const runtimeName = basename(runtime)
  const runningUnderBun = runtimeName === "bun" || runtimeName === "bun-debug"

  if (runningUnderBun && script) {
    return { command: runtime, args: [script, ...args] }
  }

  return { command: runtime, args }
}

export async function readPid() {
  try {
    const raw = await readFile(PID_PATH, "utf8")
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

export async function checkHealth(options: ServerAddress = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(`${serverUrl(options)}/health`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function statusServer(options: ServerAddress = {}): Promise<ServerStatus> {
  const [pid, running] = await Promise.all([readPid(), checkHealth(options)])
  return running ? { running, url: serverUrl(options), pid } : { running, url: serverUrl(options), pid }
}

export async function startDaemon(config: ServerConfig, options: ServerAddress = {}) {
  await ensureConfigDir()
  if (await checkHealth(options)) {
    return statusServer(options)
  }

  await ensureParentDir(LOG_PATH)
  const out = openSync(LOG_PATH, "a")
  const err = openSync(LOG_PATH, "a")
  const args = ["serve", "--port", String(resolvePort(options.port)), "--host", resolveHostname(options.hostname)]
  const command = cliCommand(args)
  const child = spawn(command.command, command.args, {
    detached: true,
    env: mergeProviderEnv(config),
    stdio: ["ignore", out, err],
  })
  child.unref()
  await writeFile(PID_PATH, `${child.pid}\n`, { mode: 0o600 })

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await checkHealth(options)) {
      return statusServer(options)
    }
    await Bun.sleep(100)
  }

  throw new Error(`0x0 server did not become healthy. Check ${LOG_PATH}.`)
}

export async function stopDaemon(options: ServerAddress = {}) {
  const pid = await readPid()
  if (!pid) {
    return false
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await checkHealth(options))) {
      await unlink(PID_PATH).catch(() => undefined)
      return true
    }
    await Bun.sleep(100)
  }

  throw new Error(`0x0 server process ${pid} did not stop.`)
}

export function logPathExists() {
  return existsSync(LOG_PATH)
}
