import type { Session } from "@anonymous-dev/0x0-server/session"

type WorktreeMode = NonNullable<Session.Info["worktreeMode"]>

let locked: WorktreeMode | undefined

export const worktreeChoice = {
  get(): WorktreeMode | undefined {
    return locked
  },
  lock(mode: WorktreeMode) {
    locked = mode
  },
  unlock() {
    locked = undefined
  },
}
