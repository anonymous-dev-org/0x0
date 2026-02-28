export namespace ProviderAuth {
  /** Check whether the given provider is usable.
   *  claude-code: requires ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN env var.
   *  codex: requires the codex binary on PATH.
   *  @param envPath  Override the PATH used for codex lookup (useful in tests).
   */
  export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
    const opts = envPath !== undefined ? { PATH: envPath } : undefined
    if (providerID === "claude-code") {
      const hasToken =
        !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_OAUTH_TOKEN
      return Promise.resolve(hasToken)
    }
    if (providerID === "codex") {
      return Promise.resolve(Bun.which("codex", opts) !== null)
    }
    return Promise.resolve(false)
  }
}
