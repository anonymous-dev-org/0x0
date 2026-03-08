import type { Session } from "@anonymous-dev/0x0-server/session"
import type { DialogContext } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import path from "path"

type WorktreeMode = NonNullable<Session.Info["worktreeMode"]>

export type DialogWorktreeProps = {
  sandboxes: string[]
  onSelect: (mode: WorktreeMode) => void
}

export function DialogWorktree(props: DialogWorktreeProps) {
  const options: DialogSelectOption<WorktreeMode>[] = [
    {
      title: "Create new worktree",
      description: "Create a new branch and worktree for this session",
      value: "create",
    },
    {
      title: "Use current directory",
      description: "Work directly in the current directory without isolation",
      value: "skip",
    },
    ...props.sandboxes.map(
      (sandbox): DialogSelectOption<WorktreeMode> => ({
        title: path.basename(sandbox),
        description: "Reuse existing worktree",
        value: { reuse: sandbox },
        category: "Existing worktrees",
      })
    ),
  ]

  return (
    <DialogSelect<WorktreeMode>
      options={options}
      onSelect={option => props.onSelect(option.value)}
      placeholder="Select worktree"
    />
  )
}

DialogWorktree.show = (dialog: DialogContext, sandboxes: string[]): Promise<WorktreeMode | undefined> => {
  return new Promise<WorktreeMode | undefined>(resolve => {
    dialog.show({
      title: "Worktree",
      body: () => (
        <DialogWorktree
          sandboxes={sandboxes}
          onSelect={mode => {
            resolve(mode)
            dialog.clear()
          }}
        />
      ),
      onClose: () => resolve(undefined),
    })
  })
}
