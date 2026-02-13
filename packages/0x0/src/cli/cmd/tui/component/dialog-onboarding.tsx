import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { createSignal, Show } from "solid-js"

export function DialogOnboarding(props: { onKeepDefaults: () => Promise<void>; onUseCustom: () => Promise<void> }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const [choice, setChoice] = createSignal<"default" | "custom">("default")
  const [busy, setBusy] = createSignal(false)
  const [hover, setHover] = createSignal<"default" | "custom" | undefined>()

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    try {
      if (choice() === "default") await props.onKeepDefaults()
      if (choice() === "custom") await props.onUseCustom()
    } finally {
      setBusy(false)
    }
  }

  useKeyboard((evt) => {
    if (busy()) return

    if (evt.name === "left" || evt.name === "up" || (evt.shift && evt.name === "tab")) {
      evt.preventDefault()
      setChoice("default")
      return
    }

    if (evt.name === "right" || evt.name === "down" || evt.name === "tab") {
      evt.preventDefault()
      setChoice("custom")
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      submit()
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Welcome to 0x0
        </text>
        <text fg={theme.textMuted}>quick start</text>
      </box>

      <box flexDirection="column" paddingBottom={1}>
        <text fg={theme.textMuted}>Switch agents with {keybind.print("agent_cycle")}</text>
        <text fg={theme.textMuted}>Type / to open command suggestions</text>
        <text fg={theme.textMuted}>Press {keybind.print("command_list")} to browse all commands</text>
      </box>

      <text fg={theme.text}>How do you want to start?</text>
      <text fg={theme.textMuted}>You can always change this later in 0x0.yaml.</text>

      <box flexDirection="column" gap={1} paddingBottom={1}>
        <Option
          title="Use default agents"
          description="Start with build, plan, general, and explore"
          active={choice() === "default"}
          hover={hover() === "default"}
          busy={busy()}
          onMouseOver={() => setHover("default")}
          onMouseOut={() => setHover(undefined)}
          onMouseUp={() => {
            setChoice("default")
            submit()
          }}
        />

        <Option
          title="Use my own agents"
          description="Disable defaults and keep only your custom setup"
          active={choice() === "custom"}
          hover={hover() === "custom"}
          busy={busy()}
          onMouseOver={() => setHover("custom")}
          onMouseOut={() => setHover(undefined)}
          onMouseUp={() => {
            setChoice("custom")
            submit()
          }}
        />
      </box>

      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted}>tab/arrows to choose, enter to confirm</text>
        <Show when={busy()}>
          <text fg={theme.textMuted}>Applying...</text>
        </Show>
      </box>
    </box>
  )
}

function Option(props: {
  title: string
  description: string
  active: boolean
  hover: boolean
  busy: boolean
  onMouseOver: () => void
  onMouseOut: () => void
  onMouseUp: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active || props.hover ? theme.primary : theme.backgroundElement}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={() => {
        if (props.busy) return
        props.onMouseUp()
      }}
    >
      <text fg={props.active || props.hover ? theme.selectedListItemText : theme.text}>
        <span style={{ attributes: TextAttributes.BOLD }}>{props.title}</span>
        <span style={{ fg: props.active || props.hover ? theme.selectedListItemText : theme.textMuted }}>
          {" "}
          {props.description}
        </span>
      </text>
    </box>
  )
}
