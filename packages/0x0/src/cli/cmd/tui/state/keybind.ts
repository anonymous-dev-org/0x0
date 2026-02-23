import { createMemo, onCleanup } from "solid-js"
import { sync } from "@tui/state/sync"
import { Keybind } from "@/util/keybind"
import { pipe, mapValues } from "remeda"
import type { KeybindsConfig } from "@/server/types"
import type { ParsedKey, Renderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer } from "@opentui/solid"

type KeybindState = {
  readonly all: { [K in keyof KeybindsConfig]?: Keybind.Info[] }
  readonly leader: boolean
  parse(evt: ParsedKey): Keybind.Info
  match(key: keyof KeybindsConfig, evt: ParsedKey): boolean | undefined
  print(key: keyof KeybindsConfig): string
}

let _state: KeybindState

export function createKeybind() {
  const keybinds = createMemo(() => {
    return pipe(
      sync.data.config.keybinds ?? {},
      mapValues((value) => Keybind.parse(value)),
    )
  })
  const [store, setStore] = createStore({
    leader: false,
  })
  const renderer = useRenderer()

  let focus: Renderable | null
  let timeout: NodeJS.Timeout
  function leader(active: boolean) {
    if (active) {
      setStore("leader", true)
      focus = renderer.currentFocusedRenderable
      focus?.blur()
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        if (!store.leader) return
        leader(false)
        if (!focus || focus.isDestroyed) return
        focus.focus()
      }, 2000)
      return
    }

    if (!active) {
      if (focus && !renderer.currentFocusedRenderable) {
        focus.focus()
      }
      setStore("leader", false)
    }
  }

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  useKeyboard(async (evt) => {
    if (!store.leader && _state.match("leader", evt)) {
      leader(true)
      return
    }

    if (store.leader && evt.name) {
      setImmediate(() => {
        if (focus && renderer.currentFocusedRenderable === focus) {
          focus.focus()
        }
        leader(false)
      })
    }
  })

  _state = {
    get all() {
      return keybinds()
    },
    get leader() {
      return store.leader
    },
    parse(evt: ParsedKey): Keybind.Info {
      // Handle special case for Ctrl+Underscore (represented as \x1F)
      if (evt.name === "\x1F") {
        return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, store.leader)
      }
      return Keybind.fromParsedKey(evt, store.leader)
    },
    match(key: keyof KeybindsConfig, evt: ParsedKey) {
      const keybind = keybinds()[key]
      if (!keybind) return false
      const parsed: Keybind.Info = _state.parse(evt)
      for (const key of keybind) {
        if (Keybind.match(key, parsed)) {
          return true
        }
      }
    },
    print(key: keyof KeybindsConfig) {
      const first = keybinds()[key]?.at(0)
      if (!first) return ""
      const result = Keybind.toString(first)
      return result.replace("<leader>", Keybind.toString(keybinds().leader![0]!))
    },
  }
}

export const keybind: KeybindState = new Proxy({} as KeybindState, {
  get: (_, key) => (_state as any)[key],
})
