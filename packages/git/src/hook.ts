import { existsSync } from "fs"
import { readFile, writeFile, mkdir, chmod } from "fs/promises"
import { join, resolve, basename, dirname } from "path"

const MARKER_START = "# 0x0-git:start"
const MARKER_END = "# 0x0-git:end"

/**
 * Build the hook script with an embedded absolute path to 0x0-git.
 * Falls back to PATH lookup so the hook still works if the binary moves.
 */
function buildHookScript(): string {
  // Resolve the absolute path at install time so the hook works in
  // environments with a restricted PATH (e.g. nvim launched from a GUI).
  const binPath = Bun.which("0x0-git")

  const resolveCmd = binPath
    ? `ZEROXZERO_GIT="${binPath}"
  if [ ! -x "$ZEROXZERO_GIT" ]; then
    command -v 0x0-git >/dev/null 2>&1 && ZEROXZERO_GIT="0x0-git" || return 0
  fi`
    : `command -v 0x0-git >/dev/null 2>&1 || return 0
  ZEROXZERO_GIT="0x0-git"`

  return `${MARKER_START}
# AI commit message generation — https://github.com/anonymous-dev-org/0x0
__0x0_git_hook() {
  ${resolveCmd}
  COMMIT_MSG_FILE="$1"
  COMMIT_SOURCE="$2"
  # Skip if message already provided (-m), merge, squash, or amend
  if [ -z "$COMMIT_SOURCE" ]; then
    MSG=$("$ZEROXZERO_GIT" commit-msg 2>/dev/null) || true
    if [ -n "$MSG" ]; then
      printf '%s\\n' "$MSG" > "$COMMIT_MSG_FILE"
    fi
  fi
}
__0x0_git_hook "$@"
${MARKER_END}`
}

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

/**
 * Detect if a directory is a husky v9 internal `_/` stub directory.
 * Husky v9 sets core.hooksPath to `.husky/_` and puts an `h` dispatcher there.
 * User scripts go in the parent `.husky/` directory.
 */
function isHuskyStubDir(dir: string): boolean {
  return basename(dir) === "_" && existsSync(join(dir, "h"))
}

async function getHooksDir(): Promise<{ hooksDir: string; huskyDir?: string }> {
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
      const resolved = resolve(repoRoot, text.trim())

      // Husky v9: core.hooksPath points to .husky/_ (stub dir).
      // User hook scripts belong in the parent .husky/ directory.
      if (isHuskyStubDir(resolved)) {
        return { hooksDir: dirname(resolved), huskyDir: resolved }
      }

      return { hooksDir: resolved }
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

  return { hooksDir: join(resolve(repoRoot, gitDir), "hooks") }
}

export async function installHook(): Promise<string> {
  const { hooksDir, huskyDir } = await getHooksDir()
  const hookPath = join(hooksDir, "prepare-commit-msg")

  await mkdir(hooksDir, { recursive: true })

  // If husky v9 was detected, clean up any previous mis-install in the stub dir
  if (huskyDir) {
    const stubPath = join(huskyDir, "prepare-commit-msg")
    if (existsSync(stubPath)) {
      const stubContent = await readFile(stubPath, "utf-8")
      if (stubContent.includes(MARKER_START)) {
        const re = new RegExp(
          `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
        )
        const cleaned = stubContent.replace(re, "\n")
        await writeFile(stubPath, cleaned)
      }
    }
  }

  let existing = ""
  if (existsSync(hookPath)) {
    existing = await readFile(hookPath, "utf-8")

    // Already installed
    if (existing.includes(MARKER_START)) {
      return `Hook already installed at ${hookPath}`
    }
  }

  // Build new hook content
  const hookScript = buildHookScript()
  let content: string
  if (existing) {
    // Append to existing hook
    content = existing.trimEnd() + "\n\n" + hookScript + "\n"
  } else {
    content = "#!/bin/sh\n\n" + hookScript + "\n"
  }

  await writeFile(hookPath, content)
  await chmod(hookPath, 0o755)

  return `Hook installed at ${hookPath}`
}

export async function uninstallHook(): Promise<string> {
  const { hooksDir, huskyDir } = await getHooksDir()

  // Also check the husky stub dir for a previous mis-install
  const candidates = [join(hooksDir, "prepare-commit-msg")]
  if (huskyDir) {
    candidates.push(join(huskyDir, "prepare-commit-msg"))
  }

  let removed = false
  for (const hookPath of candidates) {
    if (!existsSync(hookPath)) continue
    const content = await readFile(hookPath, "utf-8")
    if (!content.includes(MARKER_START)) continue

    // Remove our section (including surrounding blank lines)
    const re = new RegExp(
      `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
    )
    let cleaned = content.replace(re, "\n")

    // If only the shebang remains, remove the file entirely
    if (cleaned.replace(/^#!.*\n?/, "").trim() === "") {
      const { unlink } = await import("fs/promises")
      await unlink(hookPath)
      if (!removed) removed = true
      continue
    }

    await writeFile(hookPath, cleaned)
    removed = true
  }

  if (!removed) {
    return "0x0-git hook not found in prepare-commit-msg"
  }

  return `Hook removed from ${candidates[0]}`
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
