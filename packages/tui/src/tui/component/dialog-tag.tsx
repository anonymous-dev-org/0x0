import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { sdk } from "@tui/state/sdk"
import { createStore } from "solid-js/store"

export function DialogTag(props: { onSelect?: (value: string) => void }) {
  const dialog = useDialog()

  const [store] = createStore({
    filter: "",
  })

  const [files] = createResource(
    () => [store.filter],
    async (): Promise<string[]> => {
      const res = await sdk.client.find.file.$get({
        query: { query: store.filter },
      } as any).catch(() => undefined)
      if (!res) return []
      const data = await (res as any).json()
      return ((data ?? []) as string[]).slice(0, 5)
    },
  )

  const options = createMemo(() =>
    (files() ?? []).map((file: any) => ({
      value: file as string,
      title: file as string,
    })),
  )

  return (
    <DialogSelect
      options={options()}
      onSelect={(option) => {
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}
