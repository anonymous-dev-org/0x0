import { existsSync } from "fs"
import { readFile, writeFile, mkdir, chmod } from "fs/promises"
import { join, resolve, basename, dirname } from "path"

const MARKER_START = "# 0x0-git:start"
const MARKER_END = "# 0x0-git:end"

function buildHookScript(): string {
  const binPath = Bun.which("0x0") || process.execPath

  const resolveCmd = binPath
    ? `ZEROXZERO_GIT="${binPath}"
  if [ ! -x "$ZEROXZERO_GIT" ]; then
    command -v 0x0 >/dev/null 2>&1 && ZEROXZERO_GIT="0x0" || return 0
  fi`
    : `command -v 0x0 >/dev/null 2>&1 || return 0
  ZEROXZERO_GIT="0x0"`

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

function isHuskyStubDir(dir: string): boolean {
  return basename(dir) === "_" && existsSync(join(dir, "h"))
}

async function getHooksDir(): Promise<{ hooksDir: string; huskyDir?: string }> {
  const repoRoot = await getRepoRoot()

  try {
    const proc = Bun.spawn(["git", "config", "core.hooksPath"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode === 0 && text.trim()) {
      const resolved = resolve(repoRoot, text.trim())

      if (isHuskyStubDir(resolved)) {
        return { hooksDir: dirname(resolved), huskyDir: resolved }
      }

      return { hooksDir: resolved }
    }
  } catch {
    // fall through
  }

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

    if (existing.includes(MARKER_START)) {
      return `Hook already installed at ${hookPath}`
    }
  }

  const hookScript = buildHookScript()
  let content: string
  if (existing) {
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

  const candidates = [join(hooksDir, "prepare-commit-msg")]
  if (huskyDir) {
    candidates.push(join(huskyDir, "prepare-commit-msg"))
  }

  let removed = false
  for (const hookPath of candidates) {
    if (!existsSync(hookPath)) continue
    const content = await readFile(hookPath, "utf-8")
    if (!content.includes(MARKER_START)) continue

    const re = new RegExp(
      `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
    )
    let cleaned = content.replace(re, "\n")

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
