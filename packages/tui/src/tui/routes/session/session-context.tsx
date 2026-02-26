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
  return text.replaceAll("[REDACTED]", "").trim()
}

