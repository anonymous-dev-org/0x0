import { useRenderer } from "@opentui/solid"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { DialogMcp } from "@tui/component/dialog-mcp"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { useKV } from "../context/kv"
import type { RouteContext } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogHelp } from "../ui/dialog-help"
import { useExit } from "../context/exit"
import type { Accessor, Setter } from "solid-js"
import open from "open"
import { writeHeapSnapshot } from "v8"

export function registerAppCommands(props: {
  command: ReturnType<typeof useCommandDialog>
  connected: ReturnType<typeof useConnected>
  dialog: ReturnType<typeof useDialog>
  exit: ReturnType<typeof useExit>
  kv: ReturnType<typeof useKV>
  local: ReturnType<typeof useLocal>
  mode: Accessor<"dark" | "light">
  promptRef: ReturnType<typeof usePromptRef>
  renderer: ReturnType<typeof useRenderer>
  route: RouteContext
  sdk: ReturnType<typeof useSDK>
  setMode: (mode: "dark" | "light") => void
  setTerminalTitleEnabled: Setter<boolean>
  sync: ReturnType<typeof useSync>
  terminalTitleEnabled: Accessor<boolean>
  toast: ReturnType<typeof useToast>
}) {
  props.command.register(() => [
    {
      title: "Switch session",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      suggested: props.sync.data.session.length > 0,
      slash: {
        name: "sessions",
        aliases: ["resume", "continue"],
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: "New session",
      suggested: props.route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "Session",
      slash: {
        name: "new",
        aliases: ["clear"],
      },
      onSelect: async () => {
        const current = props.promptRef.current
        const currentPrompt = current?.current?.input ? current.current : undefined
        const result = await props.sdk.client.session.create({}).catch(() => undefined)
        if (!result?.data?.id) {
          props.toast.show({
            variant: "error",
            message: "Failed to create session",
          })
          return
        }
        props.route.navigate({
          type: "session",
          sessionID: result.data.id,
          initialPrompt: currentPrompt,
        })
        props.dialog.clear()
      },
    },
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "Agent",
      slash: {
        name: "models",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Model cycle",
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.model.cycle(1)
      },
    },
    {
      title: "Model cycle reverse",
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.model.cycle(-1)
      },
    },
    {
      title: "Favorite cycle",
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.model.cycleFavorite(1)
      },
    },
    {
      title: "Favorite cycle reverse",
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.model.cycleFavorite(-1)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      slash: {
        name: "agents",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: "Toggle MCPs",
      value: "mcp.list",
      category: "Agent",
      slash: {
        name: "mcps",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: "Agent cycle",
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.agent.move(1)
      },
    },
    {
      title: "Variant cycle",
      value: "variant.cycle",
      keybind: "variant_cycle",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.model.variant.cycle()
      },
    },
    {
      title: "Agent cycle reverse",
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        props.local.agent.move(-1)
      },
    },
    {
      title: "Connect provider",
      value: "provider.connect",
      suggested: !props.connected(),
      slash: {
        name: "connect",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogProviderList />)
      },
      category: "Provider",
    },
    {
      title: "View status",
      keybind: "status_view",
      value: "zeroxzero.status",
      slash: {
        name: "status",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogStatus />)
      },
      category: "System",
    },
    {
      title: "Switch theme",
      value: "theme.switch",
      keybind: "theme_list",
      slash: {
        name: "themes",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogThemeList />)
      },
      category: "System",
    },
    {
      title: "Toggle appearance",
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        props.setMode(props.mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Help",
      value: "help.show",
      slash: {
        name: "help",
      },
      onSelect: () => {
        props.dialog.replace(() => <DialogHelp />)
      },
      category: "System",
    },
    {
      title: "Open docs",
      value: "docs.open",
      onSelect: () => {
        open("https://zeroxzero.ai/docs").catch(() => {})
        props.dialog.clear()
      },
      category: "System",
    },
    {
      title: "Exit the app",
      value: "app.exit",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: () => props.exit(),
      category: "System",
    },
    {
      title: "Toggle debug panel",
      category: "System",
      value: "app.debug",
      onSelect: (dialog) => {
        props.renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: "Toggle console",
      category: "System",
      value: "app.console",
      onSelect: (dialog) => {
        props.renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: "Write heap snapshot",
      category: "System",
      value: "app.heap_snapshot",
      onSelect: (dialog) => {
        const path = writeHeapSnapshot()
        props.toast.show({
          variant: "info",
          message: `Heap snapshot written to ${path}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: "Suspend terminal",
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "System",
      hidden: true,
      onSelect: () => {
        process.once("SIGCONT", () => {
          props.renderer.resume()
        })

        props.renderer.suspend()
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: props.terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: "System",
      onSelect: (dialog) => {
        props.setTerminalTitleEnabled((prev) => {
          const next = !prev
          props.kv.set("terminal_title_enabled", next)
          if (!next) props.renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
    {
      title: props.kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
      value: "app.toggle.animations",
      category: "System",
      onSelect: (dialog) => {
        props.kv.set("animations_enabled", !props.kv.get("animations_enabled", true))
        dialog.clear()
      },
    },
    {
      title: props.kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
      value: "app.toggle.diffwrap",
      category: "System",
      onSelect: (dialog) => {
        const current = props.kv.get("diff_wrap_mode", "word")
        props.kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
  ])
}
