import { describe, expect, test } from "bun:test"
import { buildPrompt } from "../src/git/prompt"
import { resolveConfig } from "../src/git/config"

describe("git", () => {
  test("buildPrompt includes diff and file list", () => {
    const prompt = buildPrompt({
      diff: "diff --git a/test.ts\n+console.log('hello')",
      files: ["test.ts", "other.ts"],
    })

    expect(prompt).toContain("Conventional Commits")
    expect(prompt).toContain("- test.ts")
    expect(prompt).toContain("- other.ts")
    expect(prompt).toContain("console.log('hello')")
  })

  test("resolveConfig uses defaults", () => {
    // This will throw if no provider is available, which is expected in test env
    try {
      const config = resolveConfig()
      expect(config.url).toBe("http://localhost:4096")
      expect(config.verbose).toBe(false)
    } catch (e) {
      // Expected: no provider available in test env
      expect((e as Error).message).toContain("No LLM provider found")
    }
  })

  test("resolveConfig respects flags", () => {
    const config = resolveConfig({
      provider: "claude",
      model: "claude-sonnet-4-6",
      verbose: true,
    })

    expect(config.provider).toBe("claude")
    expect(config.model).toBe("claude-sonnet-4-6")
    expect(config.verbose).toBe(true)
  })
})
