import { parseNameStatus } from "./agent/tools"
import type { ChangedFile, Session } from "@anonymous-dev/0x0-contracts"
import { copyFile, mkdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

export type SessionRecord = Session & {
  worktreePath: string
  baseRef: string
  agentRef: string
}

export type SessionSnapshot = {
  session: SessionRecord
  files: ChangedFile[]
}

export type WorktreeManagerOptions = {
  stateRoot?: string
}

function defaultStateRoot() {
  const home = process.env.HOME ?? "/tmp"
  return `${process.env.XDG_STATE_HOME ?? `${home}/.local/state`}/0x0`
}

function refsForSession(sessionId: string) {
  return {
    baseRef: `refs/0x0/session/${sessionId}/baseline`,
    agentRef: `refs/0x0/session/${sessionId}/head`,
  }
}

export function publicRefName(ref: string) {
  return ref.startsWith("refs/") ? ref.slice("refs/".length) : ref
}

async function runGit(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function assertGit(result: CommandResult, action: string) {
  if (result.code !== 0) {
    throw new Error(`${action} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true })
}

async function fileExists(path: string) {
  return Bun.file(path).exists()
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function assertSafePath(filePath: string) {
  if (!filePath || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid file path: ${filePath}`)
  }
}

async function applyPatchToRepo(repoRoot: string, patch: string) {
  if (!patch.trim()) {
    return
  }
  const apply = Bun.spawn(["git", "apply", "--whitespace=nowarn"], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  apply.stdin.write(patch)
  apply.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(apply.stdout).text(),
    new Response(apply.stderr).text(),
    apply.exited,
  ])
  assertGit({ code, stdout, stderr }, "Apply agent diff")
}

export class WorktreeManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly stateRoot: string
  private readonly worktreeRoot: string
  private readonly registryPath: string

  constructor(options: WorktreeManagerOptions = {}) {
    this.stateRoot = options.stateRoot ?? defaultStateRoot()
    this.worktreeRoot = path.join(this.stateRoot, "worktrees")
    this.registryPath = path.join(this.stateRoot, "sessions.json")
  }

  async loadSessions() {
    if (!(await fileExists(this.registryPath))) {
      return
    }

    const raw = await Bun.file(this.registryPath).json().catch(() => undefined)
    const records = Array.isArray((raw as { sessions?: unknown })?.sessions)
      ? (raw as { sessions: unknown[] }).sessions
      : []

    this.sessions.clear()
    for (const record of records) {
      if (!this.isSessionRecord(record)) {
        continue
      }
      if (await this.isUsableSession(record)) {
        this.sessions.set(record.id, record)
      }
    }
  }

  listSessions() {
    return [...this.sessions.values()]
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId)
  }

  async createSession(input: {
    repoRoot: string
    provider: Session["provider"]
    model: string
  }): Promise<SessionRecord> {
    const root = assertGit(await runGit(["rev-parse", "--show-toplevel"], input.repoRoot), "Resolve repo root")
    const head = assertGit(await runGit(["rev-parse", "HEAD"], root), "Resolve HEAD")
    const id = crypto.randomUUID()
    const worktreePath = `${this.worktreeRoot}/${id}`
    const refs = refsForSession(id)

    await ensureDir(this.worktreeRoot)
    assertGit(await runGit(["worktree", "add", "--detach", worktreePath, head], root), "Create agent worktree")
    assertGit(await runGit(["update-ref", refs.baseRef, head], root), "Create baseline ref")
    assertGit(await runGit(["update-ref", refs.agentRef, head], root), "Create agent ref")

    const session: SessionRecord = {
      id,
      repoRoot: root,
      provider: input.provider,
      model: input.model,
      createdAt: new Date().toISOString(),
      worktreePath,
      baseRef: refs.baseRef,
      agentRef: refs.agentRef,
    }
    this.sessions.set(id, session)
    await this.saveSessions()
    return session
  }

  async checkpoint(sessionId: string) {
    const session = this.requireSession(sessionId)
    const status = await runGit(["status", "--porcelain"], session.worktreePath)
    assertGit(status, "Read worktree status")

    if (status.stdout.trim()) {
      assertGit(await runGit(["add", "-A"], session.worktreePath), "Stage agent changes")
      const commit = await runGit(
        [
          "-c",
          "user.name=0x0 Agent",
          "-c",
          "user.email=0x0-agent@localhost",
          "commit",
          "-m",
          `0x0 checkpoint ${session.id}`,
          "--no-verify",
        ],
        session.worktreePath,
      )
      assertGit(commit, "Commit agent checkpoint")
    }

    const head = assertGit(await runGit(["rev-parse", "HEAD"], session.worktreePath), "Resolve agent HEAD")
    assertGit(await runGit(["update-ref", session.agentRef, head], session.repoRoot), "Update agent ref")
    return this.status(sessionId)
  }

  async sync(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId)
    const pending = await this.status(sessionId)
    const hasPendingProposal = pending.files.length > 0
    const previousBase = assertGit(await runGit(["rev-parse", session.baseRef], session.repoRoot), "Resolve previous baseline")
    const previousAgent = assertGit(await runGit(["rev-parse", session.agentRef], session.repoRoot), "Resolve previous agent head")

    const repoHead = assertGit(await runGit(["rev-parse", "HEAD"], session.repoRoot), "Resolve repo HEAD")
    assertGit(await runGit(["reset", "--hard", repoHead], session.worktreePath), "Reset agent worktree")

    const changedPaths = await this.userChangedPaths(session.repoRoot)
    for (const filePath of changedPaths) {
      await this.copyUserPathToWorktree(session, filePath)
    }

    if (changedPaths.length) {
      assertGit(await runGit(["add", "-A"], session.worktreePath), "Stage synced user changes")
      const commit = await runGit(
        [
          "-c",
          "user.name=0x0 Agent",
          "-c",
          "user.email=0x0-agent@localhost",
          "commit",
          "-m",
          `0x0 baseline ${session.id}`,
          "--no-verify",
        ],
        session.worktreePath,
      )
      assertGit(commit, "Commit synced baseline")
    }

    const baseline = assertGit(await runGit(["rev-parse", "HEAD"], session.worktreePath), "Resolve synced baseline")
    assertGit(await runGit(["update-ref", session.baseRef, baseline], session.repoRoot), "Update baseline ref")
    if (hasPendingProposal) {
      await this.replayAgentProposal(session, previousBase, previousAgent)
      const agentHead = assertGit(await runGit(["rev-parse", "HEAD"], session.worktreePath), "Resolve replayed agent HEAD")
      assertGit(await runGit(["update-ref", session.agentRef, agentHead], session.repoRoot), "Update agent ref")
    } else {
      assertGit(await runGit(["update-ref", session.agentRef, baseline], session.repoRoot), "Update agent ref")
    }
    return this.status(sessionId)
  }

  async status(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId)
    const diff = await runGit(
      ["diff", "--name-status", session.baseRef, session.agentRef],
      session.repoRoot,
    )
    assertGit(diff, "Read agent diff")
    return { session, files: parseNameStatus(diff.stdout) }
  }

  async acceptAll(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId)
    const patch = await runGit(
      ["diff", "--binary", session.baseRef, session.agentRef],
      session.repoRoot,
    )
    assertGit(patch, "Create accept patch")
    await applyPatchToRepo(session.repoRoot, patch.stdout)
    await this.resetProposal(sessionId)
    return this.status(sessionId)
  }

  async acceptFile(sessionId: string, filePath: string): Promise<SessionSnapshot> {
    assertSafePath(filePath)
    const session = this.requireSession(sessionId)
    const patch = await runGit(
      ["diff", "--binary", session.baseRef, session.agentRef, "--", filePath],
      session.repoRoot,
    )
    assertGit(patch, "Create file accept patch")
    await applyPatchToRepo(session.repoRoot, patch.stdout)
    await this.copyPathBetweenRefs(session, session.baseRef, session.agentRef, filePath)
    return this.status(sessionId)
  }

  async discardAll(sessionId: string): Promise<SessionSnapshot> {
    await this.resetProposal(sessionId)
    return this.status(sessionId)
  }

  async discardFile(sessionId: string, filePath: string): Promise<SessionSnapshot> {
    assertSafePath(filePath)
    const session = this.requireSession(sessionId)
    if (await this.refHasPath(session.repoRoot, session.baseRef, filePath)) {
      assertGit(
        await runGit(
          ["restore", "--source", session.baseRef, "--staged", "--worktree", "--", filePath],
          session.worktreePath,
        ),
        "Restore file from baseline",
      )
    } else {
      assertGit(await runGit(["rm", "--force", "--ignore-unmatch", "--", filePath], session.worktreePath), "Remove added file")
    }
    return this.checkpoint(sessionId)
  }

  async deleteSession(sessionId: string) {
    const session = this.requireSession(sessionId)
    await this.resetProposal(sessionId)
    assertGit(await runGit(["worktree", "remove", "--force", session.worktreePath], session.repoRoot), "Remove agent worktree")
    assertGit(await runGit(["update-ref", "-d", session.baseRef], session.repoRoot), "Delete baseline ref")
    assertGit(await runGit(["update-ref", "-d", session.agentRef], session.repoRoot), "Delete agent ref")
    this.sessions.delete(sessionId)
    await this.saveSessions()
  }

  private async resetProposal(sessionId: string) {
    const session = this.requireSession(sessionId)
    const head = assertGit(await runGit(["rev-parse", "HEAD"], session.repoRoot), "Resolve repo HEAD")
    assertGit(await runGit(["update-ref", session.baseRef, head], session.repoRoot), "Reset baseline ref")
    assertGit(await runGit(["update-ref", session.agentRef, head], session.repoRoot), "Reset agent ref")
    assertGit(await runGit(["reset", "--hard", head], session.worktreePath), "Reset agent worktree")
  }

  private async copyPathBetweenRefs(
    session: SessionRecord,
    targetRef: string,
    sourceRef: string,
    filePath: string,
  ) {
    const indexPath = path.join(
      os.tmpdir(),
      `0x0-index-${session.id}-${crypto.randomUUID()}`,
    )
    const env = { GIT_INDEX_FILE: indexPath }

    try {
      assertGit(await runGit(["read-tree", targetRef], session.repoRoot, { env }), "Read baseline tree")
      if (await this.refHasPath(session.repoRoot, sourceRef, filePath)) {
        assertGit(
          await runGit(["restore", "--source", sourceRef, "--staged", "--", filePath], session.repoRoot, { env }),
          "Update baseline path",
        )
      } else {
        assertGit(
          await runGit(["rm", "--cached", "--ignore-unmatch", "--", filePath], session.repoRoot, { env }),
          "Remove baseline path",
        )
      }
      const newTree = assertGit(await runGit(["write-tree"], session.repoRoot, { env }), "Write baseline tree")
      const oldTree = assertGit(await runGit(["rev-parse", `${targetRef}^{tree}`], session.repoRoot), "Read old baseline tree")
      if (newTree === oldTree) {
        return
      }
      const newCommit = assertGit(
        await runGit(
          [
            "-c",
            "user.name=0x0 Agent",
            "-c",
            "user.email=0x0-agent@localhost",
            "commit-tree",
            newTree,
            "-p",
            targetRef,
            "-m",
            `0x0 accept ${filePath}`,
          ],
          session.repoRoot,
          { env },
        ),
        "Commit accepted file baseline",
      )
      assertGit(await runGit(["update-ref", targetRef, newCommit], session.repoRoot), "Update baseline ref")
    } finally {
      await rm(indexPath, { force: true })
    }
  }

  private async refHasPath(repoRoot: string, ref: string, filePath: string) {
    const result = await runGit(["ls-tree", "--name-only", ref, "--", filePath], repoRoot)
    assertGit(result, "Inspect ref path")
    return result.stdout.trim().length > 0
  }

  private async replayAgentProposal(session: SessionRecord, previousBase: string, previousAgent: string) {
    if (previousBase === previousAgent) {
      return
    }

    const merge = await runGit(
      [
        "-c",
        "user.name=0x0 Agent",
        "-c",
        "user.email=0x0-agent@localhost",
        "merge",
        "--no-edit",
        "-X",
        "theirs",
        previousAgent,
      ],
      session.worktreePath,
    )
    if (merge.code === 0) {
      return
    }

    await this.resolveAgentConflicts(session, previousAgent)
    const commit = await runGit(
      [
        "-c",
        "user.name=0x0 Agent",
        "-c",
        "user.email=0x0-agent@localhost",
        "commit",
        "--no-edit",
        "--no-verify",
      ],
      session.worktreePath,
    )
    assertGit(commit, "Commit replayed agent proposal")
  }

  private async resolveAgentConflicts(session: SessionRecord, previousAgent: string) {
    const changed = assertGit(
      await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], session.worktreePath),
      "Read unresolved agent paths",
    )
    const paths = changed.split("\0").filter(Boolean)
    for (const filePath of paths) {
      assertSafePath(filePath)
      if (await this.refHasPath(session.repoRoot, previousAgent, filePath)) {
        assertGit(
          await runGit(["restore", "--source", previousAgent, "--staged", "--worktree", "--", filePath], session.worktreePath),
          "Resolve conflicted file from agent proposal",
        )
      } else {
        assertGit(
          await runGit(["rm", "--force", "--ignore-unmatch", "--", filePath], session.worktreePath),
          "Resolve conflicted file deletion from agent proposal",
        )
      }
    }
    assertGit(await runGit(["add", "-A"], session.worktreePath), "Stage resolved agent proposal")
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
    return session
  }

  private async userChangedPaths(repoRoot: string) {
    const worktreeOutput = assertGit(
      await runGit(["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"], repoRoot),
      "Read user checkout changes",
    )
    const stagedOutput = assertGit(
      await runGit(["diff", "--cached", "--name-only", "-z"], repoRoot),
      "Read staged user changes",
    )
    return [...new Set(`${worktreeOutput}\0${stagedOutput}`
      .split("\0")
      .filter(Boolean)
      .sort())]
  }

  private async copyUserPathToWorktree(session: SessionRecord, filePath: string) {
    assertSafePath(filePath)
    const source = path.join(session.repoRoot, filePath)
    const target = path.join(session.worktreePath, filePath)
    if (await fileExists(source)) {
      await ensureDir(path.dirname(target))
      await copyFile(source, target)
      return
    }
    await rm(target, { recursive: true, force: true })
  }

  private async saveSessions() {
    await ensureDir(this.stateRoot)
    await Bun.write(
      this.registryPath,
      JSON.stringify({ sessions: this.listSessions() }, null, 2),
    )
  }

  private isSessionRecord(value: unknown): value is SessionRecord {
    if (!value || typeof value !== "object") {
      return false
    }
    const record = value as Partial<SessionRecord>
    return typeof record.id === "string" &&
      typeof record.repoRoot === "string" &&
      (record.provider === "codex" || record.provider === "claude") &&
      typeof record.model === "string" &&
      typeof record.createdAt === "string" &&
      typeof record.worktreePath === "string" &&
      typeof record.baseRef === "string" &&
      typeof record.agentRef === "string"
  }

  private async isUsableSession(session: SessionRecord) {
    if (!(await pathExists(session.repoRoot)) || !(await pathExists(session.worktreePath))) {
      return false
    }
    return (await runGit(["rev-parse", "--verify", session.baseRef], session.repoRoot)).code === 0 &&
      (await runGit(["rev-parse", "--verify", session.agentRef], session.repoRoot)).code === 0
  }
}
