import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { runCodeTool } from "./tools"

describe("code tools", () => {
  it("rejects path escapes for list and search tools", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-tools-test-"))
    try {
      const context = { repoRoot: root, worktreePath: root }

      const list = await runCodeTool(context, "list_files", { path: "../" })
      const search = await runCodeTool(context, "search", { pattern: "secret", path: "/tmp" })

      expect(list.ok).toBe(false)
      expect(list.output).toContain("Path escapes worktree")
      expect(search.ok).toBe(false)
      expect(search.output).toContain("Path escapes worktree")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects bash commands with absolute or parent paths", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-tools-test-"))
    try {
      const context = { repoRoot: root, worktreePath: root }

      const absolute = await runCodeTool(context, "bash", { command: "cat /etc/passwd" })
      const parent = await runCodeTool(context, "bash", { command: "cat ../secret.txt" })

      expect(absolute.ok).toBe(false)
      expect(parent.ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("observes cancellation before tool execution", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-tools-test-"))
    try {
      const controller = new AbortController()
      controller.abort()

      const result = await runCodeTool(
        { repoRoot: root, worktreePath: root },
        "git_status",
        {},
        controller.signal,
      )

      expect(result.ok).toBe(false)
      expect(result.output).toContain("cancelled")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
