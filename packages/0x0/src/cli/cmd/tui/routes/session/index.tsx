import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { useTheme } from "@tui/context/theme"
import { ScrollBoxRenderable, addDefaultParsers, MacOSScrollAccel, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage as AssistantMessageType,
  UserMessage as UserMessageType,
  ToolPart as ToolPartType,
} from "@0x0-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { Sidebar } from "./sidebar"
import parsers from "../../../../../../parsers-config.ts"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { UI } from "@/cli/ui.ts"
import { Logo } from "../../component/logo"
import { useSessionCommands } from "./use-session-commands"
import { SessionMessages } from "./session-messages"
import { shouldShowAssistantHeader } from "./assistant-header"
import { SessionContext, CustomSpeedScroll, extractReasoningTitle } from "./session-context"
import { Thinking } from "./thinking"
import { UserMessage } from "./user-message"
import { AssistantMessage } from "./assistant-message"

addDefaultParsers(parsers.parsers)

export function Session() {
  const routeContext = useRoute()
  const route = routeContext.data
  const { navigate } = routeContext
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })

  const pending = () => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  }

  const latestToolPart = (sessionID: string, runningOnly: boolean) => {
    const sessionMessages = sync.data.message[sessionID] ?? []
    for (let mi = sessionMessages.length - 1; mi >= 0; mi--) {
      const message = sessionMessages[mi]
      if (!message || message.role !== "assistant") continue

      const parts = sync.data.part[message.id] ?? []
      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const part = parts[pi]
        if (!part || part.type !== "tool") continue

        const tool = part as ToolPartType
        if (runningOnly && tool.state.status !== "running") continue
        if (!runningOnly && tool.state.status === "pending") continue
        return tool
      }
    }
  }

  const toolStatus = (part: ToolPartType, seen = new Set<string>()) => {
    if (part.tool === "task" && part.state.status !== "pending") {
      const sessionId =
        part.state.metadata && typeof part.state.metadata.sessionId === "string"
          ? part.state.metadata.sessionId
          : undefined
      if (sessionId && !seen.has(sessionId)) {
        seen.add(sessionId)
        const nested = latestToolPart(sessionId, true) ?? latestToolPart(sessionId, false)
        if (nested) return toolStatus(nested, seen)
      }
    }

    const name = Locale.titlecase(part.tool.replaceAll("_", " "))
    if (part.state.status !== "pending") {
      const title = "title" in part.state && typeof part.state.title === "string" ? part.state.title.trim() : ""
      if (title) return `Using ${name} · ${Locale.truncate(title, 56)}`
    }

    return `Using ${name}`
  }

  const thinkingStatus = createMemo(() => {
    const pendingID = pending()
    if (!pendingID) return

    const parts = sync.data.part[pendingID] ?? []
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (!part || part.type !== "tool") continue
      const tool = part as ToolPartType
      if (tool.state.status !== "running") continue
      return toolStatus(tool)
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (part?.type !== "reasoning") continue

      const title = extractReasoningTitle(part.text)
      if (!title) continue

      return Locale.truncate(title, 72)
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (!part || part.type !== "tool") continue
      const tool = part as ToolPartType
      if (tool.state.status === "pending") continue
      return toolStatus(tool)
    }
    return "Thinking"
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)

  const wide = () => dimensions().width > 120
  const sidebarVisible = () => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  }
  const showTimestamps = () => timestamps() === "show"
  const contentWidth = () => dimensions().width - (sidebarVisible() ? 42 : 0) - 2

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }

    return new CustomSpeedScroll(3)
  })

  let version = 0
  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        version += 1
        const current = version
        sync.session
          .sync(sessionID)
          .then(() => {
            if (current !== version) return
            if (scroll) scroll.scrollBy(100_000)
          })
          .catch((e) => {
            if (current !== version) return
            console.error(e)
            toast.show({
              message: `Session not found: ${sessionID}`,
              variant: "error",
            })
            return sdk.client.session.create({}).then((result) => {
              if (current !== version) return
              if (!result.data?.id) return
              navigate({
                type: "session",
                sessionID: result.data.id,
              })
            })
          })
      },
    ),
  )

  const toast = useToast()
  const sdk = useSDK()

  // Handle initial prompt from fork
  createEffect(() => {
    if (route.initialPrompt && prompt) {
      prompt.set(route.initialPrompt)
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

  // Allow exit when prompt input is hidden
  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    return exit.message.set(
      [
        ``,
        `  \u2588\u2580\u2580\u2588  ${UI.Style.TEXT_DIM}${title}${UI.Style.TEXT_NORMAL}`,
        `  \u2588  \u2588  ${UI.Style.TEXT_DIM}0x0 -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        `  \u2580\u2580\u2580\u2580  `,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()
  const status = () => sync.data.session_status?.[route.sessionID] ?? { type: "idle" }
  const busy = () => status().type === "busy" || status().type === "retry"
  const agent = () => local.agent.color(local.agent.current().name)
  const thinkingColor = createMemo(() => {
    const pendingID = pending()
    const message = pendingID ? messages().find((entry) => entry.id === pendingID) : undefined
    const agent = message?.role === "assistant" ? message.agent : undefined
    return local.agent.color(agent ?? local.agent.current().name)
  })
  const [interrupt, setInterrupt] = createSignal(0)

  const command = useCommandDialog()

  const revertInfo = () => session()?.revert

  const revertDiffFiles = () => {
    const diffText = revertInfo()?.diff ?? ""
    if (!diffText) return []

    try {
      const patches = parsePatch(diffText)
      return patches.map((patch) => {
        const filename = patch.newFileName || patch.oldFileName || "unknown"
        const cleanFilename = filename.replace(/^[ab]\//, "")
        return {
          filename: cleanFilename,
          additions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
            0,
          ),
          deletions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
            0,
          ),
        }
      })
    } catch (error) {
      return []
    }
  }

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: messages().filter((x) => x.id >= info.messageID! && x.role === "user"),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const dialog = useDialog()
  const renderer = useRenderer()

  useSessionCommands({
    command,
    route,
    sync,
    sdk,
    local,
    toast,
    renderer,
    scroll: () => scroll,
    setPrompt: (promptInfo) => prompt.set(promptInfo),
    toBottom,
    scrollToMessage,
    showThinking,
    showDetails,
    showAssistantMetadata,
    sidebarVisible,
    conceal,
    showTimestamps,
    setSidebar,
    setSidebarOpen,
    setConceal,
    setTimestamps,
    setShowThinking,
    setShowDetails,
    setShowScrollbar,
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  function RevertMarker() {
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
          <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to restore
          </text>
          <Show when={revert()!.diffFiles?.length}>
            <box marginTop={1}>
              <For each={revert()!.diffFiles}>
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

  return (
    <SessionContext.Provider
      value={{
        get width() {
          return contentWidth()
        },
        get sessionID() {
          return route.sessionID
        },
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showAssistantMetadata,
        diffWrapMode,
        sync,
      }}
    >
      <box flexDirection="row" width={dimensions().width} height={dimensions().height}>
        <box flexGrow={1} paddingLeft={1} paddingRight={1} gap={1}>
          <Show when={session()}>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: showScrollbar() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: showScrollbar(),
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <SessionMessages
                messages={messages() as (AssistantMessageType | UserMessageType)[]}
                revertMessageID={revert()?.messageID}
                fallback={
                  <box flexGrow={1} justifyContent="center" alignItems="center">
                    <Logo />
                  </box>
                }
                renderRevertMarker={() => <RevertMarker />}
                renderUser={(message, index) => (
                  <UserMessage
                    index={index}
                    onMouseUp={() => {
                      if (renderer.getSelection()?.getSelectedText()) return
                      dialog.show({
                        title: "Message Actions",
                        body: () => (
                          <DialogMessage
                            messageID={message.id}
                            sessionID={route.sessionID}
                            setPrompt={(promptInfo) => prompt.set(promptInfo)}
                          />
                        ),
                      })
                    }}
                    message={message}
                    parts={sync.data.part[message.id] ?? []}
                    pending={pending()}
                  />
                )}
                renderAssistant={(message, index) => (
                  <AssistantMessage
                    message={message}
                    parts={sync.data.part[message.id] ?? []}
                    showHeader={shouldShowAssistantHeader(messages()[index - 1], message)}
                  />
                )}
              />
            </scrollbox>
            <box flexShrink={0}>
              <Thinking
                visible={busy}
                color={() => thinkingColor()!}
                interrupt={interrupt}
                title={thinkingStatus}
                text={theme.text}
                textMuted={theme.textMuted}
                primary={theme.primary}
              />
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]!} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]!} />
              </Show>
              <Prompt
                visible={!session()?.parentID && permissions().length === 0 && questions().length === 0}
                onInterruptChange={setInterrupt}
                ref={(r) => {
                  prompt = r
                  promptRef.set(r)
                  // Apply initial prompt when prompt component mounts (e.g., from fork)
                  if (route.initialPrompt) {
                    r.set(route.initialPrompt)
                  }
                }}
                disabled={permissions().length > 0 || questions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={route.sessionID}
              />
              <Show when={!sidebarVisible() || !wide()}>
                <Footer />
              </Show>
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </SessionContext.Provider>
  )
}
