import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export type ServerConfig = {
  openAiApiKey?: string
  anthropicApiKey?: string
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
      openAiApiKey: typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : undefined,
      anthropicApiKey:
        typeof parsed.anthropicApiKey === "string" ? parsed.anthropicApiKey : undefined,
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
  return {
    ...process.env,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? config.openAiApiKey,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey,
  }
}

export function applyProviderEnv(config: ServerConfig) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? config.openAiApiKey
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey
}

export function hasProviderKey(config: ServerConfig) {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || config.openAiApiKey || config.anthropicApiKey)
}

export async function ensureParentDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}
