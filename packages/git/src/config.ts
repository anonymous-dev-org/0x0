export type Provider = "claude" | "codex"

export interface Config {
  provider: Provider
  model: string
}

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "o4-mini",
}

/**
 * Resolve provider and model from CLI flags > env vars > auto-detect.
 */
export function resolveConfig(flags?: {
  provider?: string
  model?: string
}): Config {
  const provider = resolveProvider(flags?.provider)
  const model =
    flags?.model ||
    process.env.GIT_AI_MODEL ||
    DEFAULT_MODELS[provider]

  return { provider, model }
}

function resolveProvider(flag?: string): Provider {
  // CLI flag
  if (flag === "claude" || flag === "codex") return flag

  // Env var
  const env = process.env.GIT_AI_PROVIDER
  if (env === "claude" || env === "codex") return env

  // Auto-detect: prefer claude
  if (Bun.which("claude")) return "claude"
  if (Bun.which("codex")) return "codex"

  throw new Error(
    "No LLM provider found. Install Claude Code CLI (claude) or OpenAI Codex CLI (codex).",
  )
}
