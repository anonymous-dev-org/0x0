import { Global } from "@anonymous-dev/0x0-server/core/global"
import { sync } from "@tui/state/sync"
import { createMemo } from "solid-js"

export function useDirectory() {
  return createMemo(() => {
    const directory = sync.data.path.directory || process.cwd()
    const result = directory.replace(Global.Path.home, "~")
    const branch = sync.data.vcs?.branch
    const worktreeName = sync.data.path.worktreeName
    if (worktreeName && branch) return `${result}:${worktreeName} (${branch})`
    if (worktreeName) return `${result}:${worktreeName}`
    if (branch) return `${result}:${branch}`
    return result
  })
}
