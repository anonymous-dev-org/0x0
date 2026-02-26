import { theme } from "@tui/state/theme"
import { useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { keybind } from "@tui/state/keybind"

export function DialogHelp() {
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Press {keybind.print("command_list")} to see all available actions and commands in any context.
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
