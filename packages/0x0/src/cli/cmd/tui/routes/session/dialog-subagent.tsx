import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()

  return (
    <DialogSelect
      title="Child Session Actions"
      options={[
        {
          title: "Open",
          value: "session.child.view",
          description: "the child session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
