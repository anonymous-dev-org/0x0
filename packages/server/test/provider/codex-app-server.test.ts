import { describe, expect, test } from "bun:test"
import { resolveCodexBinary } from "../../src/provider/resolve-codex-binary"
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
      'Codex CLI is not authenticated. Run "codex login" and retry.'
    )
    expect(normalizeCodexErrorMessage("authentication failed")).toBe(
      'Codex CLI is not authenticated. Run "codex login" and retry.'
    )
  })

  test("keeps non-auth errors unchanged", () => {
    expect(normalizeCodexErrorMessage(new Error("timeout while connecting"))).toBe("timeout while connecting")
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
      })
    ).toBe("first\nsecond")

    expect(
      formatMcpResult({
        structured_content: { ok: true },
      })
    ).toBe('{\n  "ok": true\n}')
  })

  test("composes turn input with system instructions when provided", () => {
    expect(composeCodexTurnInput("user prompt")).toBe("user prompt")
    expect(composeCodexTurnInput("user prompt", "be concise")).toBe(
      "<system-instructions>\nbe concise\n</system-instructions>\n\nuser prompt"
    )
  })
})

describe("codex binary resolution for SDK override", () => {
  test("resolveCodexBinary returns a path that prevents SDK findCodexPath from firing", () => {
    const codexPath = resolveCodexBinary()
    // In dev with @openai/codex installed, this must be non-null
    // so codexPathOverride is always set and SDK never calls findCodexPath()
    if (!codexPath) return // skip if platform package not installed

    expect(typeof codexPath).toBe("string")
    expect(codexPath.length).toBeGreaterThan(0)
    // The path must contain the platform-specific binary name
    expect(codexPath.endsWith("/codex") || codexPath.endsWith("\\codex.exe")).toBe(true)
  })

  test("normalizeCodexErrorMessage wraps SDK binary-not-found error distinctly", () => {
    const sdkError = new Error(
      "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies."
    )
    const normalized = normalizeCodexErrorMessage(sdkError)
    // Our normalizer should pass through non-auth errors unchanged
    expect(normalized).toContain("Unable to locate")
    // Critically: our codexAppServerStream wraps this in a constructor-specific message
    // before it ever reaches normalizeCodexErrorMessage — this test confirms
    // the fallback behavior if it somehow leaks through
    expect(normalized).not.toContain("codex login")
  })
})
