import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { TextAttributes } from "@opentui/core"
import { Terminal } from "@tui/util/terminal"
import { RouteProvider, useRoute } from "@tui/context/route"
import { createEffect, untrack, ErrorBoundary, createSignal, Show, on, onMount } from "solid-js"
import { Installation } from "@/installation"
import { Flag } from "@/flag/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { SyncProvider, useSync } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { useConnected } from "@tui/component/dialog-model"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { KeybindProvider } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Session } from "@tui/routes/session"
import { Prompt } from "./component/prompt"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session"
import { KVProvider, useKV } from "./context/kv"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { useStartupNavigation } from "./app/use-startup-navigation"
import { useAppEventHandlers } from "./app/use-app-event-handlers"
import { Logo } from "./component/logo"
import { DialogOnboarding } from "./component/dialog-onboarding"

import type { EventSource } from "./context/sdk"

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
  return new Promise<void>(async (resolve) => {
    const mode = await Terminal.getTerminalBackgroundColor().catch(() => "dark" as const)
    const onExit = async () => {
      await input.onExit?.()
      resolve()
    }

    render(
      () => {
        return (
          <ErrorBoundary
            fallback={(error, reset) => <ErrorComponent error={error} reset={reset} onExit={onExit} mode={mode} />}
          >
            <ArgsProvider {...input.args}>
              <ExitProvider onExit={onExit}>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <SDKProvider
                        url={input.url}
                        directory={input.directory}
                        fetch={input.fetch}
                        headers={input.headers}
                        events={input.events}
                      >
                        <SyncProvider>
                          <ThemeProvider mode={mode}>
                            <LocalProvider>
                              <KeybindProvider>
                                <PromptStashProvider>
                                  <DialogProvider>
                                    <CommandProvider>
                                      <FrecencyProvider>
                                        <PromptHistoryProvider>
                                          <PromptRefProvider>
                                            <App />
                                          </PromptRefProvider>
                                        </PromptHistoryProvider>
                                      </FrecencyProvider>
                                    </CommandProvider>
                                  </DialogProvider>
                                </PromptStashProvider>
                              </KeybindProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ExitProvider>
            </ArgsProvider>
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
          onCopySelection: (text) => {
            Clipboard.copy(text).catch((error) => {
              console.error(`Failed to copy console selection to clipboard: ${error}`)
            })
          },
        },
      },
    )
  })
}

function App() {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  renderer.disableStdoutInterception()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme, mode, setMode, defaultTintStrength } = useTheme()
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copyWithToast(text, toast)
    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const onboardingDone = () => kv.get("onboarding_v1_done", false)

  const showOnboarding = () => {
    dialog.replace(() => (
      <DialogOnboarding
        onKeepDefaults={async () => {
          kv.set("onboarding_v1_done", true)
          dialog.clear()
        }}
        onUseCustom={async () => {
          const current = await sdk.client.global.config.get({ throwOnError: true })
          const config = JSON.parse(JSON.stringify(current.data ?? {}))
          config.agent = config.agent ?? {}

          for (const name of ["build", "plan"]) {
            const current = config.agent[name] ?? {}
            config.agent[name] = {
              ...current,
              disable: true,
            }
          }

          const custom = sync.data.agent.find((item) => !item.native && item.hidden !== true)?.name ?? "my_agent"
          config.agent[custom] = {
            ...(config.agent[custom] ?? {}),
            mode: "primary",
            hidden: false,
            description: config.agent[custom]?.description ?? "My custom agent",
          }

          if (["build", "plan"].includes(config.default_agent)) {
            config.default_agent = custom
          }

          await sdk.client.global.config.update({ config }, { throwOnError: true })
          await sync.bootstrap()
          kv.set("onboarding_v1_done", true)
          toast.show({
            message: `Custom agent setup enabled (${custom})`,
            variant: "success",
            duration: 3000,
          })
          dialog.clear()
        }}
      />
    ))
  }

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.ZEROXZERO_DISABLE_TERMINAL_TITLE) return

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

  const args = useArgs()
  useStartupNavigation({ args, local, route, sdk, sync, toast })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0 && onboardingDone(),
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  createEffect(
    on(
      () => sync.ready && kv.ready && !onboardingDone(),
      (show, shown) => {
        if (!show || shown) return
        showOnboarding()
      },
    ),
  )

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
        defaultTintStrength,
        promptRef,
        renderer,
        route,
        sdk,
        setMode,
        setTerminalTitleEnabled,
        sync,
        terminalTitleEnabled,
        toast,
        showOnboarding,
      })
    })
  })

  createEffect(() => {
    const currentModel = local.model.current()
    if (!currentModel) return
    if (currentModel.providerID === "openrouter" && !kv.get("openrouter_warning", false)) {
      untrack(() => {
        DialogAlert.show(
          dialog,
          "Warning",
          "While openrouter is a convenient way to access LLMs your request will often be routed to subpar providers that do not work well in our testing.\n\nFor reliable access to models check out Terminal Agent Zen\nhttps://zeroxzero.ai/zen",
        ).then(() => kv.set("openrouter_warning", true))
      })
    }
  })

  useAppEventHandlers({ command, route, sdk, sync, toast })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      onMouseUp={async () => {
        if (Flag.ZEROXZERO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) {
          renderer.clearSelection()
          return
        }
        const text = renderer.getSelection()?.getSelectedText()
        if (text && text.length > 0) {
          await Clipboard.copyWithToast(text, toast)
          renderer.clearSelection()
        }
      }}
    >
      <Show
        when={route.data.sessionID}
        fallback={
          <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <Logo />
            </box>
            <Prompt
              visible
              ref={(r) => {
                promptRef.set(r)
              }}
              onSubmit={() => {}}
            />
          </box>
        }
      >
        <Session />
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
    props.onExit()
  }

  useKeyboard((evt) => {
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
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
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
        {copied() && <text fg={colors.muted}>Successfully copied</text>}
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
