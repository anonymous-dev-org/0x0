import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"

export function Thinking(props: {
  visible: () => boolean
  phase: () => string | undefined
  detail: () => string | undefined
  color: () => RGBA
  interrupt: () => number
  text: RGBA
  textMuted: RGBA
  primary: RGBA
}) {
  const [dots, setDots] = createSignal(Array.from({ length: 18 }, () => 0.45))
  const animationDurationMs = 550

  const dot = (opacity: number) => {
    const color = props.color()
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    return RGBA.fromInts(Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), alpha)
  }

  const label = () => {
    const phase = props.phase()
    const detail = props.detail()
    if (phase === "writing") return "Writing"
    if (phase === "tool") return detail ?? "Running tool"
    return "Thinking"
  }

  createEffect(() => {
    if (!props.visible()) return

    const random = (value: number) => {
      const step = (Math.random() - 0.5) * 0.5
      return Math.max(0.18, Math.min(0.82, value + step))
    }

    let current = Array.from({ length: 18 }, () => 0.45)
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
      <box paddingRight={3} flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden" alignItems="center">
          <box flexDirection="column" flexShrink={0} gap={0}>
            <text>
              <For each={[0, 1, 2, 3, 4, 5]}>
                {(col) => <span style={{ fg: dot(dots()[col] ?? 0.45), bg: dot(dots()[col + 6] ?? 0.45) }}>▀</span>}
              </For>
            </text>
            <text>
              <For each={[0, 1, 2, 3, 4, 5]}>
                {(col) => <span style={{ fg: dot(dots()[col + 12] ?? 0.45) }}>▀</span>}
              </For>
            </text>
          </box>
          <text fg={props.textMuted} attributes={TextAttributes.DIM}>
            {label()}
          </text>
        </box>
        <text flexShrink={0} fg={props.interrupt() > 0 ? props.primary : props.text}>
          esc{" "}
          <span style={{ fg: props.interrupt() > 0 ? props.primary : props.textMuted }}>
            {props.interrupt() > 0 ? "again to interrupt" : "interrupt"}
          </span>
        </text>
      </box>
    </Show>
  )
}
