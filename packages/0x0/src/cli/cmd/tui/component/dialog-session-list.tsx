import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { route } from "@tui/state/route"
import { sync } from "@tui/state/sync"
import { createMemo, createSignal, createResource, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { keybind } from "@tui/state/keybind"
import { theme } from "@tui/state/theme"
import { sdk } from "@tui/state/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { kv } from "@tui/state/kv"
import { Spinner } from "./spinner"
import { debounce } from "@solid-primitives/scheduled"

export function DialogSessionList() {
  const dialog = useDialog()

  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearchValue] = createSignal("")
  const setSearch = debounce((value: string) => setSearchValue(value), 150)

  const [searchResults] = createResource(search, async (query) => {
    if (!query) return undefined
    const res = await sdk.client.session.$get({ query: { search: query, limit: "30" } } as any)
    return await (res as any).json() ?? []
  })

  const currentSessionID = () => route.data.sessionID || undefined

  const sessions = () => searchResults() ?? sync.data.session

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return sessions()
      .filter((x: any) => x.parentID === undefined)
      .toSorted((a: any, b: any) => b.time.updated - a.time.updated)
      .map((x: any) => {
        const date = new Date(x.time.updated)
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }
        const isDeleting = toDelete() === x.id
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"
        return {
          title: isDeleting ? `Press ${keybind.print("session_delete")} again to confirm` : x.title,
          bg: isDeleting ? theme.error : undefined,
          value: x.id,
          category,
          footer: Locale.time(x.time.updated),
          gutter: isWorking ? <Spinner /> : undefined,
        }
      })
  })

  return (
    <DialogSelect
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              sdk.client.session[":sessionID"].$delete({
                param: { sessionID: option.value },
              } as any)
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            dialog.show({
              title: "Rename Session",
              size: "medium",
              body: () => <DialogSessionRename session={option.value} />,
            })
          },
        },
      ]}
    />
  )
}
