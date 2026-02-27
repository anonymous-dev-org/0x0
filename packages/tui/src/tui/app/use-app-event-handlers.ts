import { onCleanup } from "solid-js"
import { Installation } from "@anonymous-dev/0x0-server/core/installation"
import { Session as SessionApi } from "@anonymous-dev/0x0-server/session"
import { TuiEvent } from "@anonymous-dev/0x0-server/core/bus/tui-event"
import { route } from "@tui/state/route"
import { useCommandDialog } from "../component/dialog-command"
import { sdk } from "@tui/state/sdk"
import { sync } from "@tui/state/sync"
import { useToast } from "../ui/toast"

export function useAppEventHandlers() {
  const command = useCommandDialog()
  const toast = useToast()

  const notificationsEnabled = () => {
    const tui = sync.data.config.tui
    return tui?.terminal_notifications ?? true
  }

  let notifyId = 0
  const notify = (message: string) => {
    if (!notificationsEnabled()) return
    if (!process.stdout.isTTY) return
    const title = "0x0"
    const id = ++notifyId
    const passthrough = process.env["TMUX"] || process.env["STY"]
    const write = (seq: string) => {
      process.stdout.write(
        passthrough ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq,
      )
    }
    // OSC 99 — Kitty
    write(`\x1b]99;i=${id}:d=0;${title}\x1b\\`)
    write(`\x1b]99;i=${id}:p=body;${message}\x1b\\`)
    // OSC 9 — iTerm2, Windows Terminal, ConEmu
    write(`\x1b]9;${message}\x1b\\`)
    // OSC 777 — Ghostty, VTE, rxvt-unicode
    write(`\x1b]777;notify;${title};${message}\x07`)
    // BEL — universal fallback
    process.stdout.write("\u0007")
  }

  const busy = new Set<string>()
  const seen = new Set<string>()
  const order: string[] = []
  const mark = (id: string) => {
    if (seen.has(id)) return false
    seen.add(id)
    order.push(id)
    if (order.length <= 500) return true
    const first = order.shift()
    if (!first) return true
    seen.delete(first)
    return true
  }

  const unsubs = [
    sdk.event.on(TuiEvent.CommandExecute.type, (evt) => {
      command.trigger(evt.properties.command)
    }),
    sdk.event.on("session.status", (evt) => {
      const sessionID = evt.properties.sessionID
      const type = evt.properties.status.type
      if (type === "busy" || type === "retry") {
        busy.add(sessionID)
        return
      }
      if (type !== "idle") return
      const running = busy.has(sessionID)
      busy.delete(sessionID)
      if (!running) return
      const session = sync.session.get(sessionID)
      if (session?.parentID) return
      notify("Task complete")
    }),
    sdk.event.on("permission.asked", (evt) => {
      if (!mark(`permission:${evt.properties.id}`)) return
      notify("Permission needed")
    }),
    sdk.event.on("question.asked", (evt) => {
      if (!mark(`question:${evt.properties.id}`)) return
      notify("Input required")
    }),
    sdk.event.on(TuiEvent.ToastShow.type, (evt) => {
      toast.show({
        title: evt.properties.title,
        message: evt.properties.message,
        variant: evt.properties.variant,
        duration: evt.properties.duration,
      })
    }),
    sdk.event.on(TuiEvent.SessionSelect.type, (evt) => {
      route.navigate({
        type: "session",
        sessionID: evt.properties.sessionID,
      })
    }),
    sdk.event.on(SessionApi.Event.Deleted.type, (evt) => {
      if (route.data.type !== "session" || route.data.sessionID !== evt.properties.info.id) return
      sdk.client.session
        .$post({ json: {} } as any)
        .then((res: any) => res.json())
        .then((result: any) => {
          if (!result?.id) return
          route.navigate({
            type: "session",
            sessionID: result.id,
          })
        })
        .finally(() => {
          toast.show({
            variant: "info",
            message: "The current session was deleted",
          })
        })
    }),
    sdk.event.on(SessionApi.Event.Error.type, (evt) => {
      const error = evt.properties.error
      if (error && typeof error === "object" && error.name === "MessageAbortedError") return
      const message = (() => {
        if (!error) return "An error occurred"

        if (typeof error === "object") {
          const data = error.data
          if ("message" in data && typeof data.message === "string") {
            return data.message
          }
        }
        return String(error)
      })()

      toast.show({
        variant: "error",
        message,
        duration: 5000,
      })
    }),
    sdk.event.on(Installation.Event.UpdateAvailable.type, (evt) => {
      toast.show({
        variant: "info",
        title: "Update Available",
        message: `Terminal Agent v${evt.properties.version} is available. Run '0x0 upgrade' to update manually.`,
        duration: 10000,
      })
    }),
  ]

  onCleanup(() => {
    unsubs.forEach((unsub) => unsub())
    busy.clear()
    seen.clear()
    order.length = 0
  })
}
