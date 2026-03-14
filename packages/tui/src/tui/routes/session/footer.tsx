import { route } from "@tui/state/route"
import { sync } from "@tui/state/sync"
import { theme } from "@tui/state/theme"
import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useConnected } from "../../component/dialog-model"

export function Footer() {
  const mcp = () => Object.values(sync.data.mcp).filter(x => x.status === "connected").length
  const mcpError = () => Object.values(sync.data.mcp).some(x => x.status === "failed")
  const lsp = () => Object.keys(sync.data.lsp)
  const permissions = () => {
    return sync.data.permission[route.data.sessionID] ?? []
  }
  const directory = createMemo(() => {
    const dir = sync.data.path.directory || process.cwd()
    const folder = dir.split("/").pop() ?? dir
    const branch = sync.data.vcs?.branch
    const worktreeName = sync.data.path.worktreeName
    if (worktreeName && branch) return `${folder}:${worktreeName} (${branch})`
    if (worktreeName) return `${folder}:${worktreeName}`
    if (branch) return `${folder}:${branch}`
    return folder
  })
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/providers</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
