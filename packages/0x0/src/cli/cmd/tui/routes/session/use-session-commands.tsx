import path from "path"
import { batch, type Accessor, type Setter } from "solid-js"
import { type ScrollBoxRenderable } from "@opentui/core"
import { type SessionRoute } from "@tui/context/route"
import { type useSync } from "@tui/context/sync"
import { type useSDK } from "@tui/context/sdk"
import { type useLocal } from "@tui/context/local"
import { type useCommandDialog } from "@tui/component/dialog-command"
import { type useToast } from "../../ui/toast"
import { type useRenderer } from "@opentui/solid"
import { type useDialog } from "../../ui/dialog"
import { type PromptInfo } from "../../component/prompt/history"
import { Clipboard } from "../../util/clipboard"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { Editor } from "../../util/editor"

export function useSessionCommands(props: {
  command: ReturnType<typeof useCommandDialog>
  route: SessionRoute
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  local: ReturnType<typeof useLocal>
  toast: ReturnType<typeof useToast>
  renderer: ReturnType<typeof useRenderer>
  scroll: () => ScrollBoxRenderable
  setPrompt: (prompt: PromptInfo) => void
  toBottom: () => void
  scrollToMessage: (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => void
  showThinking: Accessor<boolean>
  showDetails: Accessor<boolean>
  showAssistantMetadata: Accessor<boolean>
  sidebarVisible: Accessor<boolean>
  conceal: Accessor<boolean>
  showTimestamps: Accessor<boolean>
  setSidebar: (next: Setter<"auto" | "hide">) => void
  setSidebarOpen: Setter<boolean>
  setConceal: Setter<boolean>
  setTimestamps: (next: Setter<"hide" | "show">) => void
  setShowThinking: (next: Setter<boolean>) => void
  setShowDetails: (next: Setter<boolean>) => void
  setShowScrollbar: (next: Setter<boolean>) => void
}) {
  const session = () => props.sync.session.get(props.route.sessionID)
  const messages = () => props.sync.data.message[props.route.sessionID] ?? []

  props.command.register(() => [
    {
      title: "Share session",
      value: "session.share",
      suggested: props.route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: props.sync.data.config.share !== "disabled" && !session()?.share?.url,
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        await props.sdk.client.session
          .share({
            sessionID: props.route.sessionID,
          })
          .then((res) =>
            Clipboard.copyWithToast(res.data!.share!.url, props.toast, {
              successMessage: "Share URL copied to clipboard!",
              successVariant: "success",
              errorMessage: "Failed to copy URL to clipboard",
            }),
          )
          .catch(() => props.toast.show({ message: "Failed to share session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={props.route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const scroll = props.scroll()
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={props.route.sessionID}
            setPrompt={(promptInfo) => props.setPrompt(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork from message",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const scroll = props.scroll()
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={props.route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = props.local.model.current()
        if (!selectedModel) {
          props.toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        props.sdk.client.session.summarize({
          sessionID: props.route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await props.sdk.client.session
          .unshare({
            sessionID: props.route.sessionID,
          })
          .then(() => props.toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch(() => props.toast.show({ message: "Failed to unshare session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = props.sync.data.session_status?.[props.route.sessionID]
        if (status?.type !== "idle") {
          await props.sdk.client.session.abort({ sessionID: props.route.sessionID }).catch(() => {})
        }
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        props.sdk.client.session
          .revert({
            sessionID: props.route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            props.toBottom()
          })
        const parts = props.sync.data.part[message.id]
        props.setPrompt(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          props.sdk.client.session.unrevert({
            sessionID: props.route.sessionID,
          })
          props.setPrompt({ input: "", parts: [] })
          return
        }
        props.sdk.client.session.revert({
          sessionID: props.route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: props.sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = props.sidebarVisible()
          props.setSidebar(() => (isVisible ? "hide" : "auto"))
          props.setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: props.conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: "Session",
      onSelect: (dialog) => {
        props.setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: props.showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        props.setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: props.showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        props.setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: props.showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        props.setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        props.setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const scroll = props.scroll()
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const scroll = props.scroll()
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        props.scroll().scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        props.scroll().scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const scroll = props.scroll()
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const scroll = props.scroll()
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        props.scroll().scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const scroll = props.scroll()
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = props.sync.data.message[props.route.sessionID]
        if (!messages || !messages.length) return

        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = props.sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const scroll = props.scroll()
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => props.scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => props.scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          props.toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = props.sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          props.toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          props.toast.show({ message: "No text content found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        Clipboard.copyWithToast(text, props.toast, {
          successMessage: "Message copied to clipboard!",
          successVariant: "success",
          errorMessage: "Failed to copy to clipboard",
        })
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: props.sync.data.part[msg.id] ?? [] })),
            {
              thinking: props.showThinking(),
              toolDetails: props.showDetails(),
              assistantMetadata: props.showAssistantMetadata(),
            },
          )
          await Clipboard.copyWithToast(transcript, props.toast, {
            successMessage: "Session transcript copied to clipboard!",
            successVariant: "success",
            errorMessage: "Failed to copy session transcript",
          })
        } catch {
          props.toast.show({ message: "Failed to format session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            props.showThinking(),
            props.showDetails(),
            props.showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: props.sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            await Editor.open({ value: transcript, renderer: props.renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            const result = await Editor.open({ value: transcript, renderer: props.renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            props.toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          props.toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
  ])
}
