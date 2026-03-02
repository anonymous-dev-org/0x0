import { describe, expect, test } from "bun:test"
import {
  composeCodexTurnInput,
  formatMcpResult,
  isPolicyRestrictedItem,
  normalizeCodexErrorMessage,
} from "../../src/provider/sdk/codex-app-server"

describe("codex app server policy helpers", () => {
  test("flags built-in codex tools as restricted", () => {
    expect(isPolicyRestrictedItem("command_execution")).toBe(true)
    expect(isPolicyRestrictedItem("file_change")).toBe(true)
    expect(isPolicyRestrictedItem("web_search")).toBe(true)
    expect(isPolicyRestrictedItem("mcp_tool_call")).toBe(false)
    expect(isPolicyRestrictedItem("agent_message")).toBe(false)
  })

  test("normalizes auth errors with codex login guidance", () => {
    expect(normalizeCodexErrorMessage(new Error("401 unauthorized"))).toBe(
      'Codex CLI is not authenticated. Run "codex login" and retry.',
    )
    expect(normalizeCodexErrorMessage("authentication failed")).toBe(
      'Codex CLI is not authenticated. Run "codex login" and retry.',
    )
  })

  test("keeps non-auth errors unchanged", () => {
    expect(normalizeCodexErrorMessage(new Error("timeout while connecting"))).toBe(
      "timeout while connecting",
    )
  })

  test("normalizes non-string errors safely", () => {
    expect(normalizeCodexErrorMessage(undefined)).toBe("Unknown Codex error")
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(normalizeCodexErrorMessage(circular)).toBe("[object Object]")
  })

  test("formats MCP result from text content and structured fallback", () => {
    expect(
      formatMcpResult({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond")

    expect(
      formatMcpResult({
        structured_content: { ok: true },
      }),
    ).toBe('{\n  "ok": true\n}')
  })

  test("composes turn input with system instructions when provided", () => {
    expect(composeCodexTurnInput("user prompt")).toBe("user prompt")
    expect(composeCodexTurnInput("user prompt", "be concise")).toBe(
      "<system-instructions>\nbe concise\n</system-instructions>\n\nuser prompt",
    )
  })
})
