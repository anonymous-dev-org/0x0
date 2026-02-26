import { describe, expect, test } from "bun:test"
import { shouldShowAssistantHeader } from "../../../src/tui/routes/session/assistant-header"
import type {
  AssistantHeaderMessage,
  SessionHeaderMessage,
} from "../../../src/tui/routes/session/assistant-header"

function assistant(input: { agent: string; modelID?: string }): AssistantHeaderMessage {
  return {
    role: "assistant",
    agent: input.agent,
    modelID: input.modelID,
  }
}

function user(): SessionHeaderMessage {
  return {
    role: "user",
  }
}

describe("shouldShowAssistantHeader", () => {
  test("shows header when there is no previous message", () => {
    const current = assistant({ agent: "builder", modelID: "gpt-5" })
    expect(shouldShowAssistantHeader(undefined, current)).toBe(true)
  })

  test("shows header when previous message is from user", () => {
    const previous = user()
    const current = assistant({ agent: "builder", modelID: "gpt-5" })
    expect(shouldShowAssistantHeader(previous, current)).toBe(true)
  })

  test("hides header for consecutive assistant messages with same agent and model", () => {
    const previous = assistant({ agent: "builder", modelID: "gpt-5" })
    const current = assistant({ agent: "builder", modelID: "gpt-5" })
    expect(shouldShowAssistantHeader(previous, current)).toBe(false)
  })

  test("shows header when model changes", () => {
    const previous = assistant({ agent: "builder", modelID: "gpt-5" })
    const current = assistant({ agent: "builder", modelID: "claude-4" })
    expect(shouldShowAssistantHeader(previous, current)).toBe(true)
  })

  test("shows header when agent changes", () => {
    const previous = assistant({ agent: "builder", modelID: "gpt-5" })
    const current = assistant({ agent: "planner", modelID: "gpt-5" })
    expect(shouldShowAssistantHeader(previous, current)).toBe(true)
  })
})
