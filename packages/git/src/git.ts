const MAX_DIFF_CHARS = 20_000

export interface StagedContext {
  diff: string
  files: string[]
}

/**
 * Get staged changes context for commit message generation.
 * Throws if nothing is staged.
 */
export async function getStagedContext(): Promise<StagedContext> {
  const files = await run(["git", "diff", "--cached", "--name-only"])
  const fileList = files
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)

  if (fileList.length === 0) {
    throw new Error("No staged changes. Stage files with `git add` first.")
  }

  let diff = await run(["git", "diff", "--cached"])

  // Truncate large diffs but always keep the file list
  if (diff.length > MAX_DIFF_CHARS) {
    diff =
      diff.slice(0, MAX_DIFF_CHARS) +
      "\n\n[diff truncated — full file list below]\n"
  }

  return { diff, files: fileList }
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  })

  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`${cmd.join(" ")} failed: ${stderr}`)
  }

  return text
}
