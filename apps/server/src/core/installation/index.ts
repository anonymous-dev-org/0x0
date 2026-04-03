declare global {
  const ZEROXZERO_VERSION: string
  const ZEROXZERO_CHANNEL: string
}

export namespace Installation {
  export const VERSION = typeof ZEROXZERO_VERSION === "string" ? ZEROXZERO_VERSION : "local"
  export const CHANNEL = typeof ZEROXZERO_CHANNEL === "string" ? ZEROXZERO_CHANNEL : "local"

  export function isLocal() {
    return CHANNEL === "local"
  }
}
