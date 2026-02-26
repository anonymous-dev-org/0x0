import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { sync } from "@tui/state/sync"
import { sdk } from "@tui/state/sdk"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const session = () => sync.session.get(props.session)

  return (
    <DialogPrompt
      value={session()?.title}
      onConfirm={(value) => {
        sdk.client.session[":sessionID"].$patch({
          param: { sessionID: props.session },
          json: { title: value },
        } as any)
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
