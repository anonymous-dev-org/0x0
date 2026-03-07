import { resolveCodexBinary } from "./resolve-codex-binary"

export namespace ProviderAuth {
  /** Check whether the given provider is usable.
   *  claude-code: requires the `claude` CLI binary on PATH.
   *  codex: requires the codex CLI binary (resolved from node_modules or PATH).
   *  @param envPath  Override the PATH used for binary lookup (useful in tests).
   */
  export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
    const opts = envPath !== undefined ? { PATH: envPath } : undefined
    if (providerID === "claude-code") {
      return Promise.resolve(Bun.which("claude", opts) !== null)
    }
    if (providerID === "codex") {
      // When envPath is provided (tests), only check system PATH
      if (envPath !== undefined) {
        return Promise.resolve(Bun.which("codex", opts) !== null)
      }
      return Promise.resolve(resolveCodexBinary() !== null)
    }
    return Promise.resolve(false)
  }
}
