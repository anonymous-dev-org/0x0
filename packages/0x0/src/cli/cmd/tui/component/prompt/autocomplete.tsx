import type { BoxRenderable, TextareaRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import fuzzysort from "fuzzysort"
import { firstBy } from "remeda"
import { createMemo, createEffect, onMount, onCleanup, Index, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { local } from "@tui/state/local"
import { sync } from "@tui/state/sync"
import { theme, selectedForeground } from "@tui/state/theme"
import { SplitBorder } from "@tui/component/border"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useTerminalDimensions } from "@opentui/solid"
import type { PromptInfo } from "./history"

function removeLineRange(input: string) {
  const hashIndex = input.lastIndexOf("#")
  return hashIndex !== -1 ? input.substring(0, hashIndex) : input
}

export type AutocompleteRef = {
  onInput: (value: string) => void
  onKeyDown: (e: KeyEvent) => void
  visible: false | "@" | "/"
}

export type AutocompleteOption = {
  display: string
  value?: string
  aliases?: string[]
  disabled?: boolean
  description?: string
  isDirectory?: boolean
  onSelect?: () => void
  path?: string
}

export function Autocomplete(props: {
  value: string
  sessionID?: string
  setPrompt: (input: (prompt: PromptInfo) => void) => void
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
}) {
  const command = useCommandDialog()
  const dimensions = useTerminalDimensions()

  const [store, setStore] = createStore({
    index: 0,
    selected: 0,
    visible: false as AutocompleteRef["visible"],
    input: "keyboard" as "keyboard" | "mouse",
  })

  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    const dims = dimensions()
    positionTick()
    const anchor = props.anchor()
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0

    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })

  const filter = () => {
    if (!store.visible) return
    // Track props.value to make memo reactive to text changes
    props.value // <- there surely is a better way to do this, like making .input() reactive

    return props.input().getTextRange(store.index + 1, props.input().cursorOffset)
  }

  // filter() reads reactive props.value plus non-reactive cursor/text state.
  // On keypress those can be briefly out of sync, so filter() may return an empty/partial string.
  // Copy it into search in an effect because effects run after reactive updates have been rendered and painted
  // so the input has settled and all consumers read the same stable value.
  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard so
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filter()
    setStore("input", "keyboard")
  })

  function replaceAtTrigger(text = "") {
    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    if (!text) return
    input.insertText(text)
  }

  const agents = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden)
      .map(
        (agent): AutocompleteOption => ({
          display: `@${agent.name}`,
          value: `${agent.name} agent ${agent.description ?? ""}`,
          description: agent.description,
          onSelect: () => {
            local.agent.set(agent.name)
            replaceAtTrigger()
          },
        }),
      ),
  )

  const models = createMemo(() =>
    local.model.list().map(
      (model: { id: string; name: string; provider: { id: string; name: string } }): AutocompleteOption => ({
        display: `@${model.provider.id}/${model.id}`,
        value: `${model.name} model ${model.provider.name} ${model.provider.id}/${model.id}`,
        description: model.name,
        onSelect: () => {
          local.model.set({
            providerID: model.provider.id,
            modelID: model.id,
          })
          replaceAtTrigger()
        },
      }),
    ),
  )

  const variants = createMemo(() => {
    const values = local.model.variant.list()
    if (values.length === 0) return []
    return [undefined, ...values].map(
      (variant): AutocompleteOption => ({
        display: `@${variant ?? "default"}`,
        value: `thinking ${variant ?? "default"}`,
        description: variant ? `variant: ${variant}` : "clear model variant",
        onSelect: () => {
          local.model.variant.set(variant)
          replaceAtTrigger()
        },
      }),
    )
  })

  const commands = createMemo((): AutocompleteOption[] => {
    const results: AutocompleteOption[] = [...command.slashes()]

    for (const serverCommand of sync.data.command) {
      if (serverCommand.source === "skill") continue
      const label = serverCommand.source === "mcp" ? ":mcp" : ""
      results.push({
        display: "/" + serverCommand.name + label,
        description: serverCommand.description,
        onSelect: () => {
          const newText = "/" + serverCommand.name + " "
          const cursor = props.input().logicalCursor
          props.input().deleteRange(0, 0, cursor.row, cursor.col)
          props.input().insertText(newText)
          props.input().cursorOffset = Bun.stringWidth(newText)
        },
      })
    }

    results.sort((a, b) => a.display.localeCompare(b.display))

    const max = firstBy(results, [(x) => x.display.length, "desc"])?.display.length
    if (!max) return results
    return results.map((item) => ({
      ...item,
      display: item.display.padEnd(max + 2),
    }))
  })

  const options = createMemo(() => {
    const agentsValue = agents()
    const modelsValue = models()
    const variantsValue = variants()
    const commandsValue = commands()

    const mixed: AutocompleteOption[] =
      store.visible === "@" ? [...agentsValue, ...modelsValue, ...variantsValue] : [...commandsValue]

    const searchValue = search()

    if (!searchValue) {
      return mixed
    }

    const result = fuzzysort.go(removeLineRange(searchValue), mixed, {
      keys: [
        (obj) => removeLineRange((obj.value ?? obj.display).trimEnd()),
        "description",
        (obj) => obj.aliases?.join(" ") ?? "",
      ],
      limit: 10,
    })

    return result.map((arr) => arr.obj)
  })

  createEffect(() => {
    filter()
    setStore("selected", 0)
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    if (!options().length) return
    let next = store.selected + direction
    if (next < 0) next = options().length - 1
    if (next >= options().length) next = 0
    moveTo(next)
  }

  function moveTo(next: number) {
    setStore("selected", next)
    if (!scroll) return
    const viewportHeight = Math.min(height(), options().length)
    const scrollBottom = scroll.scrollTop + viewportHeight
    if (next < scroll.scrollTop) {
      scroll.scrollBy(next - scroll.scrollTop)
    } else if (next + 1 > scrollBottom) {
      scroll.scrollBy(next + 1 - scrollBottom)
    }
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return
    hide()
    selected.onSelect?.()
  }

  function show(mode: "@" | "/") {
    command.keybinds(false)
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }

  function hide() {
    const text = props.input().plainText
    if (store.visible === "/" && !text.endsWith(" ") && text.startsWith("/")) {
      const cursor = props.input().logicalCursor
      props.input().deleteRange(0, 0, cursor.row, cursor.col)
      // Sync the prompt store immediately since onContentChange is async
      props.setPrompt((draft) => {
        draft.input = props.input().plainText
      })
    }
    command.keybinds(true)
    setStore("visible", false)
  }

  onMount(() => {
    props.ref({
      get visible() {
        return store.visible
      },
      onInput(value) {
        if (store.visible) {
          if (
            // Typed text before the trigger
            props.input().cursorOffset <= store.index ||
            // There is a space between the trigger and the cursor
            props.input().getTextRange(store.index, props.input().cursorOffset).match(/\s/) ||
            // "/<command>" is not the sole content
            (store.visible === "/" && value.match(/^\S+\s+\S+\s*$/))
          ) {
            hide()
          }
          return
        }

        // Check if autocomplete should reopen (e.g., after backspace deleted a space)
        const offset = props.input().cursorOffset
        if (offset === 0) return

        // Check for "/" at position 0 - reopen slash commands
        if (value.startsWith("/") && !value.slice(0, offset).match(/\s/)) {
          show("/")
          setStore("index", 0)
          return
        }

        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const text = value.slice(0, offset)
        const idx = text.lastIndexOf("@")
        if (idx === -1) return

        const between = text.slice(idx)
        const before = idx === 0 ? undefined : value[idx - 1]
        if ((before === undefined || /\s/.test(before)) && !between.match(/\s/)) {
          show("@")
          setStore("index", idx)
        }
      },
      onKeyDown(e: KeyEvent) {
        if (store.visible) {
          const name = e.name?.toLowerCase()
          const ctrlOnly = e.ctrl && !e.meta && !e.shift
          const isNavUp = name === "up" || (ctrlOnly && name === "p")
          const isNavDown = name === "down" || (ctrlOnly && name === "n")

          if (isNavUp) {
            setStore("input", "keyboard")
            move(-1)
            e.preventDefault()
            return
          }
          if (isNavDown) {
            setStore("input", "keyboard")
            move(1)
            e.preventDefault()
            return
          }
          if (name === "escape") {
            hide()
            e.preventDefault()
            return
          }
          if (name === "return") {
            select()
            e.preventDefault()
            return
          }
        }
        if (!store.visible) {
          if (e.name === "@") {
            const cursorOffset = props.input().cursorOffset
            const charBeforeCursor =
              cursorOffset === 0 ? undefined : props.input().getTextRange(cursorOffset - 1, cursorOffset)
            const canTrigger = charBeforeCursor === undefined || charBeforeCursor === "" || /\s/.test(charBeforeCursor)
            if (canTrigger) show("@")
          }

          if (e.name === "/") {
            if (props.input().cursorOffset === 0) show("/")
          }
        }
      },
    })
  })

  const height = () => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    return Math.min(10, count, Math.max(1, props.anchor().y))
  }

  let scroll: ScrollBoxRenderable

  return (
    <box
      visible={store.visible !== false}
      position="absolute"
      top={position().y - height()}
      left={position().x}
      width={position().width}
      zIndex={100}
      {...SplitBorder}
      borderColor={theme.border}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        backgroundColor={theme.backgroundMenu}
        height={height()}
        scrollbarOptions={{ visible: false }}
      >
        <Index
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>No matching items</text>
            </box>
          }
        >
          {(option, index) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index === store.selected ? theme.primary : undefined}
              flexDirection="row"
              onMouseMove={() => {
                setStore("input", "mouse")
              }}
              onMouseOver={() => {
                if (store.input !== "mouse") return
                moveTo(index)
              }}
              onMouseDown={() => {
                setStore("input", "mouse")
                moveTo(index)
              }}
              onMouseUp={() => select()}
            >
              <text fg={index === store.selected ? selectedForeground(theme) : theme.text} flexShrink={0}>
                {option().display}
              </text>
              <Show when={option().description}>
                <text fg={index === store.selected ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                  {option().description}
                </text>
              </Show>
            </box>
          )}
        </Index>
      </scrollbox>
    </box>
  )
}
