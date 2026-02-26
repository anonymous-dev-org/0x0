import { createMemo, createSignal, Switch, Match } from "solid-js"
import { local } from "@tui/state/local"
import { sync } from "@tui/state/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "@tui/ui/dialog-select"
import { theme } from "@tui/state/theme"
import { Keybind } from "@anonymous-dev/0x0-server/util/keybind"
import { TextAttributes } from "@opentui/core"
import { sdk } from "@tui/state/sdk"

function Status(props: { enabled: boolean; loading: boolean }) {
  return (
    <Switch fallback={<span style={{ fg: theme.textMuted }}>○ Disabled</span>}>
      <Match when={props.loading}>
        <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
      </Match>
      <Match when={props.enabled}>
        <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
      </Match>
    </Switch>
  )
}

export function DialogMcp() {
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? "failed" : status.status,
        footer: <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} />,
        category: undefined,
      })),
    )
  })

  const keybinds = [
    {
      keybind: Keybind.parse("space")[0],
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          // Refresh MCP status from server
          const res = await sdk.client.mcp.$get()
          const data = await (res as any).json()
          if (data) {
            sync.set("mcp", data)
          } else {
            console.error("Failed to refresh MCP status: no data returned")
          }
        } catch (error) {
          console.error("Failed to toggle MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
  ]

  return (
    <DialogSelect
      ref={setRef}
      options={options()}
      keybind={keybinds}
      onSelect={(option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}
