import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { WorktreeManager } from "./worktree"

async function run(args: string[], cwd: string) {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr || stdout}`)
  }
  return stdout.trim()
}

describe("worktree manager", () => {
  it("checkpoints an agent worktree and accepts the diff into the user checkout", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "example.txt"), "before\n")
      await run(["git", "add", "example.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await Bun.write(join(session.worktreePath, "example.txt"), "after\n")

      const checkpoint = await manager.checkpoint(session.id)
      expect(checkpoint.files).toEqual([{ path: "example.txt", status: "modified" }])
      expect(await Bun.file(join(root, "example.txt")).text()).toBe("before\n")

      const accepted = await manager.acceptAll(session.id)
      expect(accepted.files).toEqual([])
      expect(await Bun.file(join(root, "example.txt")).text()).toBe("after\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("accepts and discards individual files", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "accepted.txt"), "accepted before\n")
      await Bun.write(join(root, "discarded.txt"), "discarded before\n")
      await run(["git", "add", "accepted.txt", "discarded.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await Bun.write(join(session.worktreePath, "accepted.txt"), "accepted after\n")
      await Bun.write(join(session.worktreePath, "discarded.txt"), "discarded after\n")
      await manager.checkpoint(session.id)

      const accepted = await manager.acceptFile(session.id, "accepted.txt")
      expect(accepted.files).toEqual([{ path: "discarded.txt", status: "modified" }])
      expect(await Bun.file(join(root, "accepted.txt")).text()).toBe("accepted after\n")
      expect(await Bun.file(join(root, "discarded.txt")).text()).toBe("discarded before\n")

      const discarded = await manager.discardFile(session.id, "discarded.txt")
      expect(discarded.files).toEqual([])
      expect(await Bun.file(join(root, "accepted.txt")).text()).toBe("accepted after\n")
      expect(await Bun.file(join(root, "discarded.txt")).text()).toBe("discarded before\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("syncs untracked, staged, and non-ignored user files into the agent baseline", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, ".gitignore"), "ignored.txt\n")
      await Bun.write(join(root, "tracked.txt"), "before\n")
      await run(["git", "add", ".gitignore", "tracked.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await mkdir(join(root, "src"), { recursive: true })
      await Bun.write(join(root, "src", "new.txt"), "untracked\n")
      await Bun.write(join(root, "staged.txt"), "staged\n")
      await run(["git", "add", "staged.txt"], root)
      await Bun.write(join(root, "ignored.txt"), "ignored\n")

      const synced = await manager.sync(session.id)

      expect(synced.files).toEqual([])
      expect(await Bun.file(join(session.worktreePath, "src", "new.txt")).text()).toBe("untracked\n")
      expect(await Bun.file(join(session.worktreePath, "staged.txt")).text()).toBe("staged\n")
      expect(await Bun.file(join(session.worktreePath, "ignored.txt")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("replays pending agent changes onto new user checkout changes", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "example.txt"), "user line\nmiddle\nagent line\n")
      await run(["git", "add", "example.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await Bun.write(join(session.worktreePath, "example.txt"), "user line\nmiddle\nagent changed\n")
      await manager.checkpoint(session.id)
      await Bun.write(join(root, "example.txt"), "user changed\nmiddle\nagent line\n")

      const synced = await manager.sync(session.id)

      expect(synced.files).toEqual([{ path: "example.txt", status: "modified" }])
      expect(await Bun.file(join(session.worktreePath, "example.txt")).text()).toBe("user changed\nmiddle\nagent changed\n")

      await manager.acceptAll(session.id)
      expect(await Bun.file(join(root, "example.txt")).text()).toBe("user changed\nmiddle\nagent changed\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("prefers agent changes when replaying conflicts onto new user checkout changes", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "example.txt"), "before\n")
      await run(["git", "add", "example.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await Bun.write(join(session.worktreePath, "example.txt"), "agent\n")
      await manager.checkpoint(session.id)
      await Bun.write(join(root, "example.txt"), "user\n")

      const synced = await manager.sync(session.id)

      expect(synced.files).toEqual([{ path: "example.txt", status: "modified" }])
      expect(await Bun.file(join(session.worktreePath, "example.txt")).text()).toBe("agent\n")

      await manager.acceptAll(session.id)
      expect(await Bun.file(join(root, "example.txt")).text()).toBe("agent\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("only forces agent content for unresolved conflict files during replay", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "merged.txt"), "user line\nmiddle\nagent line\n")
      await Bun.write(join(root, "deleted.txt"), "before\n")
      await run(["git", "add", "merged.txt", "deleted.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      await Bun.write(join(session.worktreePath, "merged.txt"), "user line\nmiddle\nagent changed\n")
      await rm(join(session.worktreePath, "deleted.txt"))
      await manager.checkpoint(session.id)
      await Bun.write(join(root, "merged.txt"), "user changed\nmiddle\nagent line\n")
      await Bun.write(join(root, "deleted.txt"), "user changed\n")

      const synced = await manager.sync(session.id)

      expect(synced.files).toEqual([
        { path: "deleted.txt", status: "deleted" },
        { path: "merged.txt", status: "modified" },
      ])
      expect(await Bun.file(join(session.worktreePath, "merged.txt")).text()).toBe("user changed\nmiddle\nagent changed\n")
      expect(await Bun.file(join(session.worktreePath, "deleted.txt")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  it("reloads persisted sessions from the state registry", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "0x0-worktree-test-"))
    const stateRoot = await mkdtemp(join(os.tmpdir(), "0x0-worktree-state-"))
    try {
      await run(["git", "init"], root)
      await run(["git", "config", "user.name", "Test User"], root)
      await run(["git", "config", "user.email", "test@example.com"], root)
      await Bun.write(join(root, "example.txt"), "before\n")
      await run(["git", "add", "example.txt"], root)
      await run(["git", "commit", "-m", "initial"], root)

      const manager = new WorktreeManager({ stateRoot })
      const session = await manager.createSession({
        repoRoot: root,
        provider: "codex",
        model: "test-model",
      })
      const reloaded = new WorktreeManager({ stateRoot })
      await reloaded.loadSessions()

      expect(reloaded.getSession(session.id)).toEqual(session)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })
    }
  })
})
