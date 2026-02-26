import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, RGBA } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { theme } from "@tui/state/theme"
import { exit } from "@tui/state/exit"

export function NoCLIOverlay(props: { onRetry: () => Promise<void> }) {
  const dimensions = useTerminalDimensions()
  const [retrying, setRetrying] = createSignal(false)

  const retry = async () => {
    if (retrying()) return
    setRetrying(true)
    try {
      await props.onRetry()
    } finally {
      setRetrying(false)
    }
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      exit()
      return
    }
    if (evt.name === "r" && !retrying()) {
      evt.preventDefault()
      retry()
      return
    }
    // Swallow all other keys — the app cannot be used without a CLI
    evt.preventDefault()
    evt.stopPropagation()
  })

  return (
    <box
      position="absolute"
      width={dimensions().width}
      height={dimensions().height}
      left={0}
      top={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 210)}
    >
      <box
        width={62}
        maxWidth={dimensions().width - 4}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={2}
        paddingBottom={1}
        gap={1}
      >
        {/* Title */}
        <text style={{ fg: theme.error, attributes: TextAttributes.BOLD }}>
          No CLI tool found
        </text>

        <text fg={theme.text} wrapMode="word">
          0x0 delegates all AI operations to the{" "}
          <span style={{ fg: theme.primary }}>claude</span> or{" "}
          <span style={{ fg: theme.primary }}>codex</span> CLI. Install at least one to continue.
        </text>

        {/* Claude Code install */}
        <box gap={0}>
          <text style={{ fg: theme.textMuted, attributes: TextAttributes.BOLD }}>Claude Code</text>
          <text fg={theme.primary}>  npm install -g @anthropic-ai/claude-code</text>
          <text fg={theme.textMuted}>  then: claude login</text>
        </box>

        {/* Codex install */}
        <box gap={0}>
          <text style={{ fg: theme.textMuted, attributes: TextAttributes.BOLD }}>Codex</text>
          <text fg={theme.primary}>  npm install -g @openai/codex</text>
        </box>

        {/* Actions */}
        <Show
          when={!retrying()}
          fallback={<text fg={theme.textMuted}>Checking for installed CLIs...</text>}
        >
          <text fg={theme.textMuted}>
            Press <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>r</span> to check
            again after installing, or <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>ctrl+c</span>{" "}
            to exit.
          </text>
        </Show>
      </box>
    </box>
  )
}
