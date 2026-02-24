import path from "path"
import { batch } from "solid-js"
import { type ScrollBoxRenderable } from "@opentui/core"
import { route } from "@tui/state/route"
import { sync } from "@tui/state/sync"
import { sdk } from "@tui/state/sdk"
import { local } from "@tui/state/local"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useToast } from "../../ui/toast"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type useDialog } from "../../ui/dialog"
import { type PromptInfo } from "../../component/prompt/history"
import { Clipboard } from "../../util/clipboard"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { Editor } from "../../util/editor"
import { useSessionSettings } from "./session-settings"

export function useSessionCommands(props: {
  scroll: () => ScrollBoxRenderable
  setPrompt: (prompt: PromptInfo) => void
  toBottom: () => void
  scrollToMessage: (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => void
}) {
  const command = useCommandDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const settings = useSessionSettings()
  const dimensions = useTerminalDimensions()

  const session = () => sync.session.get(route.data.sessionID)
  const messages = () => sync.data.message[route.data.sessionID] ?? []
  const wide = () => dimensions().width > 120
  const sidebarVisible = () => {
    if (session()?.parentID) return false
    if (settings.sidebarOpen()) return true
    if (settings.sidebar() === "auto" && wide()) return true
    return false
  }

  const scrollTo = (messageID: string) => {
    const scroll = props.scroll()
    const child = scroll.getChildren().find((c) => c.id === messageID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
  }

  command.register(() => [
    {
      title: "Share session",
      value: "session.share",
      suggested: route.data.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled" && !session()?.share?.url,
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        await sdk.client.session[":sessionID"].share
          .$post({
            param: { sessionID: route.data.sessionID },
          } as any)
          .then((res: any) => res.json())
          .then((data: any) =>
            Clipboard.copyWithToast(data.share!.url, toast, {
              successMessage: "Share URL copied to clipboard!",
              successVariant: "success",
              errorMessage: "Failed to copy URL to clipboard",
            }),
          )
          .catch(() => toast.show({ message: "Failed to share session", variant: "error" }))
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
        dialog.show({
          title: "Rename Session",
          size: "medium",
          body: () => <DialogSessionRename session={route.data.sessionID} />,
        })
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
        dialog.show({
          title: "Timeline",
          size: "large",
          body: () => (
            <DialogTimeline
              onMove={scrollTo}
              sessionID={route.data.sessionID}
              setPrompt={(promptInfo) => props.setPrompt(promptInfo)}
            />
          ),
        })
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
        dialog.show({
          title: "Fork from message",
          size: "large",
          body: () => <DialogForkFromTimeline onMove={scrollTo} sessionID={route.data.sessionID} />,
        })
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
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Select a model to summarize this session",
            duration: 3000,
          })
          return
        }
        sdk.client.session[":sessionID"].summarize.$post({
          param: { sessionID: route.data.sessionID },
          json: {
            modelID: selectedModel.modelID,
            providerID: selectedModel.providerID,
          },
        } as any)
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
        await sdk.client.session[":sessionID"].share
          .$delete({
            param: { sessionID: route.data.sessionID },
          } as any)
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to unshare session", variant: "error" }))
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
        const status = sync.data.session_status?.[route.data.sessionID]
        if (status?.type !== "idle") {
          await sdk.client.session[":sessionID"].abort.$post({ param: { sessionID: route.data.sessionID } } as any).catch(() => {})
        }
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session[":sessionID"].revert
          .$post({
            param: { sessionID: route.data.sessionID },
            json: { messageID: message.id },
          } as any)
          .then(() => {
            props.toBottom()
          })
        const parts = sync.data.part[message.id] ?? []
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
          sdk.client.session[":sessionID"].unrevert.$post({
            param: { sessionID: route.data.sessionID },
          } as any)
          props.setPrompt({ input: "", parts: [] })
          return
        }
        sdk.client.session[":sessionID"].revert.$post({
          param: { sessionID: route.data.sessionID },
          json: { messageID: message.id },
        } as any)
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          settings.setSidebar(() => (isVisible ? "hide" : "auto"))
          settings.setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: settings.conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      onSelect: (dialog) => {
        settings.setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: settings.showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        settings.setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: settings.showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        settings.setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: settings.showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      slash: {
        name: "details",
      },
      onSelect: (dialog) => {
        settings.setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        settings.setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    ...([
      { title: "Page up", value: "session.page.up", keybind: "messages_page_up", amount: (s: ScrollBoxRenderable) => -s.height / 2 },
      { title: "Page down", value: "session.page.down", keybind: "messages_page_down", amount: (s: ScrollBoxRenderable) => s.height / 2 },
      { title: "Half page up", value: "session.half.page.up", keybind: "messages_half_page_up", amount: (s: ScrollBoxRenderable) => -s.height / 4 },
      { title: "Half page down", value: "session.half.page.down", keybind: "messages_half_page_down", amount: (s: ScrollBoxRenderable) => s.height / 4 },
      { title: "Line up", value: "session.line.up", keybind: "messages_line_up", amount: () => -1, disabled: true },
      { title: "Line down", value: "session.line.down", keybind: "messages_line_down", amount: () => 1, disabled: true },
    ] as const).map((cmd) => ({
      title: cmd.title,
      value: cmd.value,
      keybind: cmd.keybind,
      category: "Session" as const,
      hidden: !("disabled" in cmd && cmd.disabled),
      disabled: "disabled" in cmd && cmd.disabled,
      onSelect: (dialog: ReturnType<typeof useDialog>) => {
        const scroll = props.scroll()
        scroll.scrollBy(cmd.amount(scroll))
        dialog.clear()
      },
    })),
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first" as const,
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
      keybind: "messages_last" as const,
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
      keybind: "messages_last_user" as const,
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.data.sessionID]
        if (!messages || !messages.length) return

        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            scrollTo(message.id)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next" as const,
      category: "Session",
      hidden: true,
      onSelect: (dialog) => props.scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous" as const,
      category: "Session",
      hidden: true,
      onSelect: (dialog) => props.scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy" as const,
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({ message: "No text content found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        Clipboard.copyWithToast(text, toast, {
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
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: settings.showThinking(),
              toolDetails: settings.showDetails(),
              assistantMetadata: settings.showAssistantMetadata(),
            },
          )
          await Clipboard.copyWithToast(transcript, toast, {
            successMessage: "Session transcript copied to clipboard!",
            successVariant: "success",
            errorMessage: "Failed to copy session transcript",
          })
        } catch {
          toast.show({ message: "Failed to format session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export" as const,
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
            settings.showThinking(),
            settings.showDetails(),
            settings.showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
  ])
}
