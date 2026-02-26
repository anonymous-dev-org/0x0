import { createSignal, For, Show } from "solid-js"
import { SplitBorder } from "@tui/component/border"
import { theme } from "@tui/state/theme"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { keybind } from "@tui/state/keybind"

export function RevertMarker(props: {
  reverted: { id: string; role: string }[]
  diffFiles?: { filename: string; additions: number; deletions: number }[]
}) {
  const command = useCommandDialog()
  const [hover, setHover] = createSignal(false)
  const dialog = useDialog()

  const handleUnrevert = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Confirm Redo",
      "Are you sure you want to restore the reverted messages?",
    )
    if (confirmed) {
      command.trigger("session.redo")
    }
  }

  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={handleUnrevert}
      marginTop={1}
      flexShrink={0}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.backgroundPanel}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      >
        <text fg={theme.textMuted}>{props.reverted.length} message reverted</text>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to restore
        </text>
        <Show when={props.diffFiles?.length}>
          <box marginTop={1}>
            <For each={props.diffFiles}>
              {(file) => (
                <text fg={theme.text}>
                  {file.filename}
                  <Show when={file.additions > 0}>
                    <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                  </Show>
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}
