import { createMemo } from "solid-js"
import { sync } from "@tui/state/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@anonymous-dev/0x0-server/server/types"
import { Locale } from "@anonymous-dev/0x0-server/util/locale"
import { sdk } from "@tui/state/sdk"
import { route } from "@tui/state/route"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID: string) => void }) {
  const dialog = useDialog()

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          const forked = await sdk.client.session[":sessionID"].fork.$post({
            param: { sessionID: props.sessionID },
            json: { messageID: message.id },
          } as any).then((res: any) => res.json())
          const parts = sync.data.part[message.id] ?? []
          const initialPrompt = parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          route.navigate({
            sessionID: forked.id,
            type: "session",
            initialPrompt,
          })
          dialog.clear()
        },
      })
    }
    result.reverse()
    return result
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} options={options()} />
}
