import { TextAttributes } from "@opentui/core"
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { useConnected } from "@tui/component/dialog-model"
import { DialogProvider as DialogProviderConnect } from "@tui/component/dialog-provider"
import { Session } from "@tui/routes/session"
import { type Args, setArgs } from "@tui/state/args"
import { createExit, exit } from "@tui/state/exit"
import { createKeybind } from "@tui/state/keybind"
import { createKV, kv } from "@tui/state/kv"
import { createLocal, local } from "@tui/state/local"
import { createPromptRef, promptRef } from "@tui/state/prompt"
import { createRoute, route } from "@tui/state/route"
import { createSDK, type EventSource, sdk } from "@tui/state/sdk"
import { createSync, sync } from "@tui/state/sync"
import { createTheme, theme, themeState } from "@tui/state/theme"
import { DialogMount, DialogProvider, useDialog } from "@tui/ui/dialog"
import { Clipboard } from "@tui/util/clipboard"
import { Terminal } from "@tui/util/terminal"
import { createEffect, createSignal, ErrorBoundary, onMount, Show } from "solid-js"
import { Installation } from "@anonymous-dev/0x0-server/core/installation"
import { Session as SessionApi } from "@anonymous-dev/0x0-server/session"
import { useAppEventHandlers } from "./app/use-app-event-handlers"
import { useStartupNavigation } from "./app/use-startup-navigation"
import { Logo } from "./component/logo"
import { Prompt } from "./component/prompt"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptHistoryProvider } from "./component/prompt/history"
import { PromptStashProvider } from "./component/prompt/stash"
import { ToastProvider, useToast } from "./ui/toast"

export function tui(input: {
  url: string
  args: Args
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  onExit?: () => Promise<void>
}) {
  // promise to prevent immediate exit
  return new Promise<void>(resolve => {
    const onExit = async () => {
      await input.onExit?.()
      resolve()
    }

    // Pre-init: set args before render
    setArgs(input.args)

    render(
      () => {
        return (
          <ErrorBoundary
            fallback={(error, reset) => <ErrorComponent error={error} reset={reset} onExit={onExit} mode="dark" />}>
            <ToastProvider>
              <PromptStashProvider>
                <DialogProvider>
                  <CommandProvider>
                    <FrecencyProvider>
                      <PromptHistoryProvider>
                        <App
                          url={input.url}
                          directory={input.directory}
                          fetch={input.fetch}
                          headers={input.headers}
                          events={input.events}
                          onExit={onExit}
                        />
                      </PromptHistoryProvider>
                    </FrecencyProvider>
                  </CommandProvider>
                </DialogProvider>
              </PromptStashProvider>
            </ToastProvider>
          </ErrorBoundary>
        )
      },
      {
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: {},
        autoFocus: false,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
          onCopySelection: text => {
            Clipboard.copy(text).catch(error => {
              console.error(`Failed to copy console selection to clipboard: ${error}`)
            })
          },
        },
      }
    )
  })
}

function App(props: {
  url: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  onExit: () => Promise<void>
}) {
  // Init state modules in dependency order
  createExit({ onExit: props.onExit })
  createKV()
  createRoute()
  createSDK({
    url: props.url,
    directory: props.directory,
    fetch: props.fetch,
    headers: props.headers,
    events: props.events,
  })
  createSync()
  createTheme({ mode: "dark" })
  createLocal()
  createKeybind()
  createPromptRef()

  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  renderer.disableStdoutInterception()
  const dialog = useDialog()
  const command = useCommandDialog()
  const toast = useToast()
  const mode = themeState.mode
  const setMode = themeState.setMode
  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copyWithToast(text, toast)
    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  let terminalModeResolved = false

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!route.data.sessionID) {
      renderer.setTerminalTitle("Terminal Agent")
      return
    }

    const session = sync.session.get(route.data.sessionID)
    if (!session || SessionApi.isDefaultTitle(session.title)) {
      renderer.setTerminalTitle("Terminal Agent")
      return
    }

    // Truncate title to 40 chars max
    const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
    renderer.setTerminalTitle(`0x0 | ${title}`)
  })

  useStartupNavigation()

  createEffect(() => {
    if (terminalModeResolved) return
    if (!kv.ready) return
    terminalModeResolved = true
    if (kv.store["theme_mode"] !== undefined) return

    Terminal.getTerminalBackgroundColor({ timeoutMs: 100 }).then(detected => {
      setMode(detected)
    })
  })

  const connected = useConnected()
  onMount(() => {
    import("./app/register-app-commands").then(({ registerAppCommands }) => {
      registerAppCommands({
        command,
        connected,
        dialog,
        exit,
        kv,
        local,
        mode,
        promptRef,
        renderer,
        route,
        sdk,
        setMode,
        setTerminalTitleEnabled,
        sync,
        terminalTitleEnabled,
        toast,
      })
    })
  })
  useAppEventHandlers()

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      onMouseUp={async () => {
        const text = renderer.getSelection()?.getSelectedText()
        if (text && text.length > 0) {
          await Clipboard.copyWithToast(text, toast)
          renderer.clearSelection()
        }
      }}>
      <Show
        when={route.data.sessionID}
        fallback={
          <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <Logo />
            </box>
            <Prompt
              visible
              ref={r => {
                promptRef.set(r)
              }}
              onSubmit={() => {}}
            />
          </box>
        }>
        <Session />
      </Show>

      {/* Auto-show provider dialog when no CLI tool is detected */}
      <Show when={sync.ready && sync.data.provider_connected.length === 0}>
        <DialogMount title="Connect a provider" body={() => <DialogProviderConnect />} />
      </Show>
    </box>
  )
}

function ErrorComponent(props: {
  error: Error
  reset: () => void
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    renderer.setTerminalTitle("")
    renderer.destroy()
    await props.onExit()
  }

  useKeyboard(evt => {
    if (evt.ctrl && evt.name === "c") {
      handleExit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/anonymous-dev-org/0x0/issues/new?template=bug-report.yml")

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#6b6b6b" : "#a0a0a0",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```"
    )
  }

  issueURL.searchParams.set("zeroxzero-version", Installation.VERSION)

  const copyIssueURL = () => {
    Clipboard.copy(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          Please report an issue.
        </text>
        <box onMouseUp={copyIssueURL} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            Copy issue URL (exception info pre-filled)
          </text>
        </box>
        <Show when={copied()}>
          <text fg={colors.muted}>Successfully copied</text>
        </Show>
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={colors.text}>A fatal error occurred!</text>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={handleExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
