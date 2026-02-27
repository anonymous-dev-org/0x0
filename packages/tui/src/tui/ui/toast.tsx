import { createContext, useContext, type ParentProps, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { theme } from "@tui/state/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { TuiEvent } from "@anonymous-dev/0x0-server/core/bus/tui-event"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

export function Toast() {
  const toast = useToast()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          maxHeight={Math.max(5, dimensions().height - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <scrollbox height="100%">
            <Show when={current().title}>
              <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
                {current().title}
              </text>
            </Show>
            <text fg={theme.text} wrapMode="word" width="100%">
              {current().message}
            </text>
          </scrollbox>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
  })

  let timeoutHandle: NodeJS.Timeout | null = null

  onCleanup(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  })

  const toast = {
    show(options: ToastOptions) {
      const parsedOptions = TuiEvent.ToastShow.properties.parse(options)
      const { duration, ...currentToast } = parsedOptions
      setStore("currentToast", currentToast)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, duration).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
