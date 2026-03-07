import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { resolveCodexBinary } from "../../src/provider/resolve-codex-binary"

describe("resolveCodexBinary", () => {
  test("returns a valid executable path when @openai/codex is installed", () => {
    // Skip if the platform package isn't installed (CI without optional deps)
    const result = resolveCodexBinary()
    if (!result) return

    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(fs.existsSync(result)).toBe(true)
    expect(result).toContain("codex")
  })

  test("returned path points to an executable file", () => {
    const result = resolveCodexBinary()
    if (!result) return

    const stat = fs.statSync(result)
    expect(stat.isFile()).toBe(true)
    // Check execute permission (owner)
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o100).toBeTruthy()
  })

  test("returns the same path on repeated calls", () => {
    const first = resolveCodexBinary()
    const second = resolveCodexBinary()
    expect(first).toBe(second)
  })
})
