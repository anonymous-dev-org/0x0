import { createMemo, createSignal, For, Show } from "solid-js"
import { theme } from "@tui/state/theme"
import { local } from "@tui/state/local"
import { Locale } from "@/util/locale"
import { useSessionContext } from "./session-context"
import type { Part, UserMessage as UserMessageType } from "@/server/types"

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

export function UserMessage(props: {
  message: UserMessageType
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = useSessionContext()
  const text = () => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0]
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const [hover, setHover] = createSignal(false)
  const queued = () => props.pending && props.message.id > props.pending
  const metadataVisible = () => queued() || ctx.showTimestamps()

  const compaction = () => props.parts.find((x) => x.type === "compaction")

  return (
    <>
      <Show when={text()}>
        <box id={props.message.id} marginTop={props.index === 0 ? 0 : 1}>
          <box
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()?.text}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = () => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    }
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}
