import { createMemo } from "solid-js"
import { sync } from "@tui/state/sync"
import { Global } from "@/global"

export function useDirectory() {
  return createMemo(() => {
    const directory = sync.data.path.directory || process.cwd()
    const result = directory.replace(Global.Path.home, "~")
    if (sync.data.vcs?.branch) return result + ":" + sync.data.vcs.branch
    return result
  })
}
