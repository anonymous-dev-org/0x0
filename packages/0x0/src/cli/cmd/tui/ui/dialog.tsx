import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  Show,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { useTheme } from "@tui/context/theme"
import { Renderable, RGBA, TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "./toast"

function Dialog(
  props: ParentProps<{
    size: "medium" | "large"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  return (
    <box
      onMouseUp={async () => {
        if (renderer.getSelection()) return
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={async (e) => {
          if (renderer.getSelection()) return
          e.stopPropagation()
        }}
        width={props.size === "large" ? 80 : 60}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    current: null as null | {
      title: string
      header?: JSX.Element
      body: JSX.Element | Accessor<JSX.Element>
      onClose?: () => void
      size: "medium" | "large"
    },
  })

  useKeyboard((evt) => {
    if (evt.name === "escape" && store.current) {
      store.current.onClose?.()
      setStore("current", null)
      evt.preventDefault()
      evt.stopPropagation()
      refocus()
    }
  })

  const renderer = useRenderer()
  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  return {
    show(opts: {
      title: string
      header?: JSX.Element
      body: JSX.Element | Accessor<JSX.Element>
      onClose?: () => void
      size?: "medium" | "large"
    }) {
      if (!store.current) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      store.current?.onClose?.()
      setStore("current", {
        title: opts.title,
        header: opts.header,
        body: opts.body,
        onClose: opts.onClose,
        size: opts.size ?? "medium",
      })
    },
    clear() {
      store.current?.onClose?.()
      setStore("current", null)
      refocus()
    },
    get visible() {
      return store.current !== null
    },
    get size(): "medium" | "large" {
      return store.current?.size ?? "medium"
    },
    get current() {
      return store.current
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const body = () => {
    const b = value.current?.body
    if (!b) return undefined
    if (typeof b === "function") return b()
    return b
  }
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        onMouseUp={async () => {
          const text = renderer.getSelection()?.getSelectedText()
          if (text && text.length > 0) {
            await Clipboard.copyWithToast(text, toast)
            renderer.clearSelection()
          }
        }}
      >
        <Show when={value.visible}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
              <text attributes={TextAttributes.BOLD} fg={theme.text}>
                {value.current!.title}
              </text>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={hover() ? theme.primary : undefined}
                onMouseOver={() => setHover(true)}
                onMouseOut={() => setHover(false)}
                onMouseUp={() => value.clear()}
              >
                <text fg={hover() ? theme.selectedListItemText : theme.textMuted}>esc</text>
              </box>
            </box>
            {value.current!.header}
            {body()}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

export function DialogMount(props: { title: string; body: () => JSX.Element; size?: "medium" | "large" }) {
  const dialog = useDialog()
  onMount(() => {
    dialog.show({
      title: props.title,
      body: props.body,
      size: props.size,
    })
  })
  onCleanup(() => {
    dialog.clear()
  })
  return null
}
