import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useKV } from "@tui/context/kv"
import { useToast } from "@tui/ui/toast"
import { createSignal, Show } from "solid-js"

export function DialogOnboarding() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const kv = useKV()
  const toast = useToast()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const [choice, setChoice] = createSignal<"default" | "custom">("default")
  const [busy, setBusy] = createSignal(false)
  const [hover, setHover] = createSignal<"default" | "custom" | undefined>()

  const keepDefaults = () => {
    kv.set("onboarding_v1_done", true)
    dialog.clear()
  }

  const useCustom = async () => {
    const current = await sdk.client.global.config.get({ throwOnError: true })
    const config = JSON.parse(JSON.stringify(current.data ?? {}))
    config.agent = config.agent ?? {}

    for (const name of ["builder", "planner"]) {
      const current = config.agent[name] ?? {}
      config.agent[name] = {
        ...current,
        disable: true,
      }
    }

    const custom = sync.data.agent.find((item) => !item.native && item.hidden !== true)?.name ?? "my_agent"
    config.agent[custom] = {
      ...(config.agent[custom] ?? {}),
      name: config.agent[custom]?.name ?? "My Agent",
      color: config.agent[custom]?.color ?? "#22C55E",
      tools_allowed: config.agent[custom]?.tools_allowed ?? ["bash", "read", "search", "apply_patch", "task"],
      thinking_effort: config.agent[custom]?.thinking_effort ?? "medium",
      hidden: false,
      description: config.agent[custom]?.description ?? "My custom agent",
    }

    if (["builder", "planner"].includes(config.default_agent)) {
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
  }

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    try {
      if (choice() === "default") keepDefaults()
      if (choice() === "custom") await useCustom()
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
      <text fg={theme.text}>How do you want to start?</text>
      <text fg={theme.textMuted}>You can always change this later in 0x0.yaml.</text>

      <box flexDirection="column" gap={1} paddingBottom={1}>
        <OnboardingOption
          title="Get started"
          description="Use the built-in builder and planner agents"
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

        <OnboardingOption
          title="Custom setup"
          description="Disable built-in agents and use your own from 0x0.yaml"
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

      <box flexDirection="column" paddingBottom={1}>
        <text fg={theme.textMuted}>
          {keybind.print("agent_cycle")} switch agents {"  "}/ commands {"  "}{keybind.print("command_list")} all commands
        </text>
      </box>

      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted}>arrows to choose, enter to confirm</text>
        <Show when={busy()}>
          <text fg={theme.textMuted}>Applying...</text>
        </Show>
      </box>
    </box>
  )
}

function OnboardingOption(props: {
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
