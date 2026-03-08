import { Bus } from "@/core/bus"
import { Session } from "."

const stash = new Map<string, string>()

export namespace PromptStash {
  export function append(sessionID: string, text: string) {
    const existing = stash.get(sessionID)
    const updated = existing ? existing + "\n" + text : text
    stash.set(sessionID, updated)
    Bus.publish(Session.Event.PromptStashUpdated, { sessionID, text })
  }

  export function get(sessionID: string): string | undefined {
    return stash.get(sessionID)
  }

  export function clear(sessionID: string) {
    stash.delete(sessionID)
  }
}
