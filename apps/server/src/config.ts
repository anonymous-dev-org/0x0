import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export type ServerConfig = {
  codexAcpCommand?: string
  claudeAcpCommand?: string
}

const CONFIG_DIR = join(homedir(), ".0x0")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")
export const PID_PATH = join(CONFIG_DIR, "server.pid")
export const LOG_PATH = join(CONFIG_DIR, "server.log")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await chmod(CONFIG_DIR, 0o700).catch(() => undefined)
}

export async function readServerConfig(): Promise<ServerConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return {}
    }

    return {
      codexAcpCommand: typeof parsed.codexAcpCommand === "string" ? parsed.codexAcpCommand : undefined,
      claudeAcpCommand: typeof parsed.claudeAcpCommand === "string" ? parsed.claudeAcpCommand : undefined,
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

export async function writeServerConfig(config: ServerConfig) {
  await ensureConfigDir()
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(CONFIG_PATH, 0o600).catch(() => undefined)
}

export function mergeProviderEnv(config: ServerConfig): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (!env.ZEROXZERO_CODEX_ACP_COMMAND && config.codexAcpCommand) {
    env.ZEROXZERO_CODEX_ACP_COMMAND = config.codexAcpCommand
  }
  if (!env.ZEROXZERO_CLAUDE_ACP_COMMAND && config.claudeAcpCommand) {
    env.ZEROXZERO_CLAUDE_ACP_COMMAND = config.claudeAcpCommand
  }
  return env
}

export function applyProviderEnv(config: ServerConfig) {
  if (!process.env.ZEROXZERO_CODEX_ACP_COMMAND && config.codexAcpCommand) {
    process.env.ZEROXZERO_CODEX_ACP_COMMAND = config.codexAcpCommand
  }
  if (!process.env.ZEROXZERO_CLAUDE_ACP_COMMAND && config.claudeAcpCommand) {
    process.env.ZEROXZERO_CLAUDE_ACP_COMMAND = config.claudeAcpCommand
  }
}

export async function ensureParentDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}
