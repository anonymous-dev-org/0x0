import { createContext, useContext } from "solid-js"
import type { sync } from "@tui/state/sync"
import type { ScrollAcceleration } from "@opentui/core"

export class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

export const SessionContext = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showAssistantMetadata: () => boolean
  diffWrapMode: () => "word" | "none"
  sync: typeof sync
}>()

export function useSessionContext() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function normalizeReasoningText(text: string) {
  return text.replace("[REDACTED]", "").trim()
}

export function extractReasoningTitle(text: string) {
  const content = normalizeReasoningText(text)
  if (!content) return

  const bold = content.match(/^\*\*(.+?)\*\*/)
  if (bold?.[1]?.trim()) return bold[1].trim()

  const heading = content.match(/^#{1,6}\s+(.+)$/)
  if (heading?.[1]?.trim()) return heading[1].trim()

  const firstLine = content.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return

  const normalizedLine = firstLine.replace(/^#{1,6}\s+/, "").trim()
  const withoutPrefix = normalizedLine.replace(/^_?thinking:_?\s*/i, "").trim()
  return withoutPrefix || normalizedLine
}
