import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/core/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type { Snapshot } from "@/workspace/snapshot"

export namespace Branch {
  const log = Log.create({ service: "branch" })

  function sanitizeSlug(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
  }

  export function worktreePath(projectId: string, branchSlug: string): string {
    return path.join(Global.Path.data, "worktrees", projectId, branchSlug)
  }

  export async function create(input: {
    slug: string
    title?: string
    projectId: string
  }): Promise<{ name: string; base: string; worktree: string }> {
    const cwd = Instance.directory
    const slug = sanitizeSlug(input.title ?? input.slug)
    let branchName = `0x0/${slug}`

    // Get current branch as base
    const baseBranch = (await $`git branch --show-current`.quiet().cwd(cwd).nothrow().text()).trim() || "HEAD"

    // Check if branch already exists, append suffix if needed
    const branchExists = await $`git show-ref --verify --quiet refs/heads/${branchName}`.quiet().cwd(cwd).nothrow()
    if (branchExists.exitCode === 0) {
      let suffix = 1
      while (true) {
        const candidate = `${branchName}-${suffix}`
        const exists = await $`git show-ref --verify --quiet refs/heads/${candidate}`.quiet().cwd(cwd).nothrow()
        if (exists.exitCode !== 0) {
          branchName = candidate
          break
        }
        suffix++
        if (suffix > 100) throw new Error(`Too many branches with name ${branchName}`)
      }
    }

    const wt = worktreePath(input.projectId, sanitizeSlug(branchName))
    await fs.mkdir(path.dirname(wt), { recursive: true })

    // Create branch from HEAD
    const createBranch = await $`git branch ${branchName} HEAD`.quiet().cwd(cwd).nothrow()
    if (createBranch.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branchName}: ${createBranch.stderr.toString()}`)
    }

    // Create worktree
    const createWorktree = await $`git worktree add ${wt} ${branchName}`.quiet().cwd(cwd).nothrow()
    if (createWorktree.exitCode !== 0) {
      // Clean up the branch we just created
      await $`git branch -D ${branchName}`.quiet().cwd(cwd).nothrow()
      throw new Error(`Failed to create worktree: ${createWorktree.stderr.toString()}`)
    }

    // Configure git user in worktree for commits
    await $`git -C ${wt} config user.name "0x0"`.quiet().nothrow()
    await $`git -C ${wt} config user.email "0x0@local"`.quiet().nothrow()

    log.info("created branch", { branchName, base: baseBranch, worktree: wt })

    return { name: branchName, base: baseBranch, worktree: wt }
  }

  export async function commit(worktreePath: string, message: string): Promise<string | undefined> {
    const status = await $`git -C ${worktreePath} status --porcelain`.quiet().nothrow().text()

    if (!status.trim()) return undefined

    await $`git -C ${worktreePath} add .`.quiet().nothrow()

    const commitResult = await $`git -C ${worktreePath} commit -m ${message}`.quiet().nothrow()
    if (commitResult.exitCode !== 0) {
      log.warn("commit failed", { stderr: commitResult.stderr.toString() })
      return undefined
    }

    const hash = (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().nothrow().text()).trim()

    log.info("committed", { hash, message: message.slice(0, 72) })
    return hash
  }

  export async function currentCommit(worktreePath: string): Promise<string> {
    return (await $`git -C ${worktreePath} rev-parse HEAD`.quiet().nothrow().text()).trim()
  }

  export async function patch(worktreePath: string, fromCommit: string): Promise<{ hash: string; files: string[] }> {
    const head = await currentCommit(worktreePath)

    const result = await $`git -C ${worktreePath} diff --name-only ${fromCommit} ${head}`.quiet().nothrow().text()

    const files = result
      .trim()
      .split("\n")
      .map(f => f.trim())
      .filter(Boolean)
      .map(f => path.join(worktreePath, f))

    return { hash: head, files }
  }

  export async function diffFull(worktreePath: string, from: string, to: string): Promise<Snapshot.FileDiff[]> {
    const result: Snapshot.FileDiff[] = []
    const statusMap = new Map<string, "added" | "deleted" | "modified">()

    const statuses = await $`git -C ${worktreePath} diff --no-ext-diff --name-status --no-renames ${from} ${to}`
      .quiet()
      .nothrow()
      .text()

    for (const line of statuses.trim().split("\n")) {
      if (!line) continue
      const [code, file] = line.split("\t")
      if (!code || !file) continue
      const kind = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified"
      statusMap.set(file, kind)
    }

    const numstat = await $`git -C ${worktreePath} diff --no-ext-diff --no-renames --numstat ${from} ${to}`
      .quiet()
      .nothrow()
      .text()

    for (const line of numstat.trim().split("\n")) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      if (!file || !additions || !deletions) continue

      const isBinary = additions === "-" && deletions === "-"
      const before = isBinary ? "" : await $`git -C ${worktreePath} show ${from}:${file}`.quiet().nothrow().text()
      const after = isBinary ? "" : await $`git -C ${worktreePath} show ${to}:${file}`.quiet().nothrow().text()

      const added = isBinary ? 0 : parseInt(additions)
      const deleted = isBinary ? 0 : parseInt(deletions)

      result.push({
        file,
        before,
        after,
        additions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(deleted) ? deleted : 0,
        status: statusMap.get(file) ?? "modified",
      })
    }

    return result
  }

  export async function infoFromWorktree(worktree: string): Promise<{ name: string; base: string; worktree: string }> {
    const branchName = (await $`git -C ${worktree} branch --show-current`.quiet().nothrow().text()).trim()
    if (!branchName) throw new Error(`No branch found in worktree ${worktree}`)

    const cwd = Instance.directory
    const baseBranch = (await $`git branch --show-current`.quiet().cwd(cwd).nothrow().text()).trim() || "HEAD"

    return { name: branchName, base: baseBranch, worktree }
  }

  export async function remove(worktreePath: string, branchName: string): Promise<void> {
    const cwd = Instance.directory

    await $`git worktree remove ${worktreePath} --force`.quiet().cwd(cwd).nothrow()

    await $`git branch -D ${branchName}`.quiet().cwd(cwd).nothrow()

    log.info("removed branch", { branchName, worktree: worktreePath })
  }
}
