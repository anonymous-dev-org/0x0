import { describe, expect, test } from "bun:test"
import { ACPSessionManager } from "../../src/acp/session"
import type { ACPSessionState } from "../../src/acp/types"

function createManager() {
  const manager = new ACPSessionManager({} as never)
  const sessions = (manager as unknown as { sessions: Map<string, ACPSessionState> }).sessions
  sessions.set("session_1", {
    id: "session_1",
    cwd: "/tmp",
    mcpServers: [],
    createdAt: new Date(),
    modes: {},
  })
  return manager
}

describe("acp.session manager mode selection", () => {
  test("restores model and variant per mode", () => {
    const manager = createManager()

    manager.setMode("session_1", "build")
    manager.setModel("session_1", { providerID: "openai", modelID: "gpt-5" })
    manager.setVariant("session_1", "high")

    manager.setMode("session_1", "plan")
    expect(manager.getModel("session_1")).toBeUndefined()
    expect(manager.getVariant("session_1")).toBeUndefined()

    manager.setModel("session_1", { providerID: "anthropic", modelID: "claude-sonnet-4" })
    manager.setVariant("session_1", "low")

    manager.setMode("session_1", "build")
    expect(manager.getModel("session_1")).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(manager.getVariant("session_1")).toBe("high")

    manager.setMode("session_1", "plan")
    expect(manager.getModel("session_1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    expect(manager.getVariant("session_1")).toBe("low")
  })
})
