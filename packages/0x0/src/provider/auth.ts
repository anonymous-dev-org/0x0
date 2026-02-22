export namespace ProviderAuth {
  /** Check whether the CLI binary for the given provider is on PATH.
   *  @param envPath  Override the PATH used for lookup (useful in tests).
   */
  export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
    const opts = envPath !== undefined ? { PATH: envPath } : undefined
    if (providerID === "claude-code") {
      return Promise.resolve(Bun.which("claude", opts) !== null)
    }
    if (providerID === "codex") {
      return Promise.resolve(Bun.which("codex", opts) !== null)
    }
    return Promise.resolve(false)
  }
}
