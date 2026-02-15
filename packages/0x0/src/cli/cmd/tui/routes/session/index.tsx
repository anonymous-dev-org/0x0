import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { tint, useTheme } from "@tui/context/theme"
import {
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  RGBA,
  TextAttributes,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart, ReasoningPart } from "@0x0-ai/sdk/v2"
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
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { Flag } from "@/flag/flag"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { Logo } from "../../component/logo"
import { useSessionCommands } from "./use-session-commands"
import { SessionTool } from "./session-tools"
import { SessionMessages } from "./session-messages"

addDefaultParsers(parsers.parsers)

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showAssistantMetadata: () => boolean
  diffWrapMode: () => "word" | "none"
  sync: ReturnType<typeof useSync>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

function normalizeReasoningText(text: string) {
  return text.replace("[REDACTED]", "").trim()
}

function extractReasoningTitle(text: string) {
  const content = normalizeReasoningText(text)
  if (!content) return

  const bold = content.match(/^\*\*(.+?)\*\*/)
  if (bold?.[1]?.trim()) return bold[1].trim()

  const heading = content.match(/^#{1,6}\s+(.+)$/)
  if (heading?.[1]?.trim()) return heading[1].trim()

  const firstLine = content.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return

  const normalizedLine = firstLine.replace(/^#{1,6}\s+/, "").trim()
  const withoutPrefix = normalizedLine.replace(/^_?thinking:_?\s*/i, "").trim()
  return withoutPrefix || normalizedLine
}

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

        const tool = part as ToolPart
        if (runningOnly && tool.state.status !== "running") continue
        if (!runningOnly && tool.state.status === "pending") continue
        return tool
      }
    }
  }

  const toolStatus = (part: ToolPart, seen = new Set<string>()) => {
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
      const tool = part as ToolPart
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
      const tool = part as ToolPart
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
        `  █▀▀█  ${UI.Style.TEXT_DIM}${title}${UI.Style.TEXT_NORMAL}`,
        `  █  █  ${UI.Style.TEXT_DIM}0x0 -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        `  ▀▀▀▀  `,
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
  const status = createMemo(() => sync.data.session_status?.[route.sessionID] ?? { type: "idle" })
  const busy = () => status().type === "busy" || status().type === "retry"
  const agent = () => local.agent.color(local.agent.current().name)
  const thinkingAgent = createMemo(() => {
    const pendingID = pending()
    if (!pendingID) return

    const message = messages().find((entry) => entry.id === pendingID)
    if (!message || message.role !== "assistant") return

    return message.agent
  })
  const thinkingColor = createMemo(() => local.agent.color(thinkingAgent() ?? local.agent.current().name))
  const [interrupt, setInterrupt] = createSignal(0)

  const command = useCommandDialog()

  const revertInfo = () => session()?.revert
  const revertMessageID = () => revertInfo()?.messageID

  const revertDiffFiles = createMemo(() => {
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
  })

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
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
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
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
                messages={messages() as (AssistantMessage | UserMessage)[]}
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
                      dialog.replace(() => (
                        <DialogMessage
                          messageID={message.id}
                          sessionID={route.sessionID}
                          setPrompt={(promptInfo) => prompt.set(promptInfo)}
                        />
                      ))
                    }}
                    message={message}
                    parts={sync.data.part[message.id] ?? []}
                    pending={pending()}
                  />
                )}
                renderAssistant={(message) => (
                  <AssistantMessage message={message} parts={sync.data.part[message.id] ?? []} />
                )}
              />
            </scrollbox>
            <box flexShrink={0}>
              <Thinking
                visible={busy}
                color={thinkingColor}
                interrupt={interrupt}
                title={thinkingStatus}
                text={theme.text}
                textMuted={theme.textMuted}
                primary={theme.primary}
              />
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
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
    </context.Provider>
  )
}

function Thinking(props: {
  visible: () => boolean
  color: () => RGBA
  interrupt: () => number
  title: () => string | undefined
  text: RGBA
  textMuted: RGBA
  primary: RGBA
}) {
  const [dots, setDots] = createSignal(Array.from({ length: 12 }, () => 0.45))
  const animationDurationMs = 550

  const dot = (opacity: number) => {
    const color = props.color()
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    return RGBA.fromInts(Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), alpha)
  }

  createEffect(() => {
    if (!props.visible()) return

    const random = (value: number) => {
      const step = (Math.random() - 0.5) * 0.5
      return Math.max(0.18, Math.min(0.82, value + step))
    }

    let current = Array.from({ length: 12 }, () => 0.45)
    let start = [...current]
    let target = current.map(random)
    let started = Date.now()

    const retarget = setInterval(() => {
      current = [...target]
      setDots(current)
      start = [...current]
      target = current.map(random)
      started = Date.now()
    }, animationDurationMs)

    const frame = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / animationDurationMs)
      current = start.map((value, index) => value + (target[index]! - value) * progress)
      setDots(current)
    }, 100)

    onCleanup(() => {
      clearInterval(frame)
      clearInterval(retarget)
    })
  })

  return (
    <Show when={props.visible()}>
      <box paddingBottom={1} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text>
            <For each={[0, 1, 2, 3, 4, 5]}>
              {(col) => <span style={{ fg: dot(dots()[col] ?? 0.45), bg: dot(dots()[col + 6] ?? 0.45) }}>▀</span>}
            </For>
          </text>
          <text fg={props.textMuted} attributes={TextAttributes.DIM}>
            {props.title() ?? "Thinking"}
          </text>
        </box>
        <text fg={props.interrupt() > 0 ? props.primary : props.text}>
          esc{" "}
          <span style={{ fg: props.interrupt() > 0 ? props.primary : props.textMuted }}>
            {props.interrupt() > 0 ? "again to interrupt" : "interrupt"}
          </span>
        </text>
      </box>
    </Show>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = () => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0]
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const sync = useSync()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = () => props.pending && props.message.id > props.pending
  const metadataVisible = () => queued() || ctx.showTimestamps()

  const compaction = () => props.parts.find((x) => x.type === "compaction")

  return (
    <>
      <Show when={text()}>
        <box id={props.message.id} marginTop={props.index === 0 ? 0 : 1}>
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
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

function AssistantMessage(props: { message: AssistantMessage; parts: Part[] }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const sessionStatus = createMemo(() => sync.data.session_status?.[props.message.sessionID])
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const agentColor = createMemo(() => {
    const color = local.agent.color(props.message.agent)
    return RGBA.fromInts(Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), 255)
  })

  const final = () => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  }

  const rail = createMemo(() => {
    const color = agentColor()
    const dark = theme.text.r * 0.299 + theme.text.g * 0.587 + theme.text.b * 0.114 > 0.5
    if (dark) return color
    return tint(theme.text, color, 0.52)
  })

  const agentLabel = createMemo(() => local.agent.label(props.message.agent)?.trim() ?? "")
  const modelLabel = createMemo(() => props.message.modelID?.trim() ?? "")
  const showMetadataRow = createMemo(() => ctx.showAssistantMetadata() && Boolean(agentLabel() || modelLabel()))

  const duration = () => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  }

  const retryMessage = createMemo(() => {
    const status = sessionStatus()
    if (status?.type !== "retry") return
    if (props.message.time.completed) return
    const nextInSeconds = Math.max(0, Math.ceil((status.next - Date.now()) / 1000))
    const eta = nextInSeconds > 0 ? ` Next retry in ~${nextInSeconds}s.` : ""
    const meta = `retry_meta{attempt=${status.attempt},next_unix_ms=${status.next}}`
    return `${status.message} Attempt ${status.attempt}.${eta} ${meta}`
  })

  return (
    <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={rail()}>
      <Show when={showMetadataRow()}>
        <box paddingLeft={3} marginTop={1}>
          <text>
            <span style={{ fg: rail() }}>▣ </span>
            <Show when={agentLabel()}>
              <span style={{ fg: rail() }}>{agentLabel()}</span>
            </Show>
            <Show when={agentLabel() && modelLabel()}>
              <span style={{ fg: theme.textMuted }}> · </span>
            </Show>
            <Show when={modelLabel()}>
              <span style={{ fg: theme.textMuted }}>{modelLabel()}</span>
            </Show>
            <Show when={duration()}>
              <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
            </Show>
          </text>
        </box>
      </Show>
      <For each={props.parts}>
        {(part, index) => {
          const component = () => PART_MAPPING[part.type as keyof typeof PART_MAPPING]
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as never}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Show when={retryMessage()}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.warning}
        >
          <text fg={theme.textMuted}>{retryMessage()}</text>
        </box>
      </Show>
    </box>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

function ReasoningPart(_props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  return <></>
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.ZEROXZERO_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
            />
          </Match>
          <Match when={!Flag.ZEROXZERO_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = () => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  }

  const toolprops = {
    get ctx() {
      return ctx
    },
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get message() {
      return props.message
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <SessionTool {...toolprops} />
    </Show>
  )
}
