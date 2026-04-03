import type { AgentProvider } from "./types"
import { ClaudeProvider } from "./claude"
import { CodexProvider } from "./codex"
import { Log } from "@/util/log"

const log = Log.create({ service: "registry" })

const providers: Record<string, AgentProvider> = {
  claude: ClaudeProvider,
  codex: CodexProvider,
}

export namespace ProviderRegistry {
  export function get(id: string): AgentProvider | undefined {
    return providers[id]
  }

  export function all(): AgentProvider[] {
    return Object.values(providers)
  }

  export async function available(): Promise<AgentProvider[]> {
    const results = await Promise.all(
      Object.values(providers).map(async (p) => ({
        provider: p,
        available: await p.isAvailable(),
      })),
    )
    return results.filter((r) => r.available).map((r) => r.provider)
  }

  export async function resolve(id?: string): Promise<AgentProvider> {
    if (id) {
      const provider = providers[id]
      if (!provider) throw new Error(`Unknown provider: ${id}`)
      const avail = await provider.isAvailable()
      if (!avail) throw new Error(`Provider "${id}" is not available. Check that the CLI is installed.`)
      return provider
    }

    // Auto-detect: prefer claude, fallback to codex
    for (const pid of ["claude", "codex"] as const) {
      const p = providers[pid]!
      if (await p.isAvailable()) {
        log.info("auto-resolved", { provider: pid })
        return p
      }
    }

    throw new Error("No providers available. Install Claude CLI or Codex CLI.")
  }
}
