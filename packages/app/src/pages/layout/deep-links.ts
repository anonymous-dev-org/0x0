export const deepLinkEvent = "zeroxzero:deep-link"

export const parseDeepLink = (input: string) => {
  if (!input.startsWith("zeroxzero://")) return
  const url = new URL(input)
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

type zeroxzero = Window & {
  __ZEROXZERO__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: zeroxzero) => {
  const pending = target.__ZEROXZERO__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__ZEROXZERO__) target.__ZEROXZERO__.deepLinks = []
  return pending
}
