export type GitProvider = "claude" | "codex"

export interface GitConfig {
  provider: GitProvider
  model: string
  url: string
  auth?: { username: string; password: string }
  verbose: boolean
}

const DEFAULT_MODELS: Record<GitProvider, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "o4-mini",
}

export function resolveConfig(flags?: {
  provider?: string
  model?: string
  verbose?: boolean
}): GitConfig {
  const provider = resolveProvider(flags?.provider)
  const model =
    flags?.model ||
    process.env.GIT_AI_MODEL ||
    DEFAULT_MODELS[provider]

  const url = process.env.GIT_AI_URL || "http://localhost:4096"

  const auth = process.env.GIT_AI_AUTH
    ? (() => {
        const [username, password] = process.env.GIT_AI_AUTH!.split(":")
        return username && password ? { username, password } : undefined
      })()
    : undefined

  const verbose = flags?.verbose || process.env.GIT_AI_DEBUG === "1"

  return { provider, model, url, auth, verbose }
}

function resolveProvider(flag?: string): GitProvider {
  if (flag === "claude" || flag === "codex") return flag

  const env = process.env.GIT_AI_PROVIDER
  if (env === "claude" || env === "codex") return env

  if (Bun.which("claude")) return "claude"
  if (process.env.OPENAI_API_KEY) return "codex"

  throw new Error(
    "No LLM provider found. Install Claude Code CLI (claude) or set OPENAI_API_KEY.",
  )
}
