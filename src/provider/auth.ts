export namespace ProviderAuth {
  export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
    const opts = envPath !== undefined ? { PATH: envPath } : undefined
    if (providerID === "claude") {
      return Promise.resolve(Bun.which("claude", opts) !== null)
    }
    if (providerID === "codex") {
      // Codex provider uses OpenAI API directly — just needs the key
      return Promise.resolve(!!process.env.OPENAI_API_KEY)
    }
    return Promise.resolve(false)
  }
}
