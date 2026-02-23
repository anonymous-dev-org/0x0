import { createMemo } from "solid-js"
import { local } from "@tui/state/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function DialogAgent() {
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: local.agent.label(item.name),
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      current={local.agent.current().name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
