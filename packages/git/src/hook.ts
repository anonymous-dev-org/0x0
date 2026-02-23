import { existsSync } from "fs"
import { readFile, writeFile, mkdir, chmod } from "fs/promises"
import { join, resolve } from "path"

const MARKER_START = "# 0x0-git:start"
const MARKER_END = "# 0x0-git:end"

const HOOK_SCRIPT = `${MARKER_START}
# AI commit message generation — https://github.com/anonymous-dev-org/0x0
if command -v 0x0-git >/dev/null 2>&1; then
  COMMIT_MSG_FILE="$1"
  COMMIT_SOURCE="$2"
  # Skip if message already provided (-m), merge, squash, or amend
  if [ -z "$COMMIT_SOURCE" ]; then
    MSG=$(0x0-git commit-msg 2>/dev/null) || true
    if [ -n "$MSG" ]; then
      printf '%s\\n' "$MSG" > "$COMMIT_MSG_FILE"
    fi
  fi
fi
${MARKER_END}`

/**
 * Resolve the hooks directory for the current git repo.
 * Checks core.hooksPath first (husky compatibility), then falls back to .git/hooks.
 */
async function getRepoRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const root = (await new Response(proc.stdout).text()).trim()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error("Not a git repository")
  }
  return root
}

async function getHooksDir(): Promise<string> {
  const repoRoot = await getRepoRoot()

  // Check git config for custom hooks path
  try {
    const proc = Bun.spawn(["git", "config", "core.hooksPath"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode === 0 && text.trim()) {
      // Resolve relative paths against repo root
      return resolve(repoRoot, text.trim())
    }
  } catch {
    // fall through
  }

  // Find .git directory (resolve relative to repo root)
  const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const gitDir = (await new Response(proc.stdout).text()).trim()
  await proc.exited

  return join(resolve(repoRoot, gitDir), "hooks")
}

export async function installHook(): Promise<string> {
  const hooksDir = await getHooksDir()
  const hookPath = join(hooksDir, "prepare-commit-msg")

  await mkdir(hooksDir, { recursive: true })

  let existing = ""
  if (existsSync(hookPath)) {
    existing = await readFile(hookPath, "utf-8")

    // Already installed
    if (existing.includes(MARKER_START)) {
      return `Hook already installed at ${hookPath}`
    }
  }

  // Build new hook content
  let content: string
  if (existing) {
    // Append to existing hook
    content = existing.trimEnd() + "\n\n" + HOOK_SCRIPT + "\n"
  } else {
    content = "#!/bin/sh\n\n" + HOOK_SCRIPT + "\n"
  }

  await writeFile(hookPath, content)
  await chmod(hookPath, 0o755)

  return `Hook installed at ${hookPath}`
}

export async function uninstallHook(): Promise<string> {
  const hooksDir = await getHooksDir()
  const hookPath = join(hooksDir, "prepare-commit-msg")

  if (!existsSync(hookPath)) {
    return "No prepare-commit-msg hook found"
  }

  const content = await readFile(hookPath, "utf-8")

  if (!content.includes(MARKER_START)) {
    return "0x0-git hook not found in prepare-commit-msg"
  }

  // Remove our section (including surrounding blank lines)
  const re = new RegExp(
    `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
  )
  let cleaned = content.replace(re, "\n")

  // If only the shebang remains, remove the file entirely
  if (cleaned.replace(/^#!.*\n?/, "").trim() === "") {
    const { unlink } = await import("fs/promises")
    await unlink(hookPath)
    return `Hook removed (deleted ${hookPath})`
  }

  await writeFile(hookPath, cleaned)
  return `Hook removed from ${hookPath}`
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
