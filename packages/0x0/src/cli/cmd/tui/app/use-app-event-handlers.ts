import { onCleanup } from "solid-js"
import { Installation } from "@/installation"
import { Session as SessionApi } from "@/session"
import { TuiEvent } from "../event"
import type { RouteContext } from "../context/route"
import { useCommandDialog } from "../component/dialog-command"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"

export function useAppEventHandlers(props: {
  command: ReturnType<typeof useCommandDialog>
  route: RouteContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
}) {
  const notificationsEnabled = () => {
    const tui = props.sync.data.config.tui as { terminal_notifications?: boolean } | undefined
    return tui?.terminal_notifications ?? true
  }

  const bell = () => {
    if (!notificationsEnabled()) return
    if (!process.stdout.isTTY) return
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
    props.sdk.event.on(TuiEvent.CommandExecute.type, (evt) => {
      props.command.trigger(evt.properties.command)
    }),
    props.sdk.event.on("session.status", (evt) => {
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
      const session = props.sync.session.get(sessionID)
      if (session?.parentID) return
      bell()
    }),
    props.sdk.event.on("permission.asked", (evt) => {
      if (!mark(`permission:${evt.properties.id}`)) return
      bell()
    }),
    props.sdk.event.on("question.asked", (evt) => {
      if (!mark(`question:${evt.properties.id}`)) return
      bell()
    }),
    props.sdk.event.on(TuiEvent.ToastShow.type, (evt) => {
      props.toast.show({
        title: evt.properties.title,
        message: evt.properties.message,
        variant: evt.properties.variant,
        duration: evt.properties.duration,
      })
    }),
    props.sdk.event.on(TuiEvent.SessionSelect.type, (evt) => {
      props.route.navigate({
        type: "session",
        sessionID: evt.properties.sessionID,
      })
    }),
    props.sdk.event.on(SessionApi.Event.Deleted.type, (evt) => {
      if (props.route.data.type !== "session" || props.route.data.sessionID !== evt.properties.info.id) return
      props.sdk.client.session
        .create({})
        .then((result) => {
          if (!result.data?.id) return
          props.route.navigate({
            type: "session",
            sessionID: result.data.id,
          })
        })
        .finally(() => {
          props.toast.show({
            variant: "info",
            message: "The current session was deleted",
          })
        })
    }),
    props.sdk.event.on(SessionApi.Event.Error.type, (evt) => {
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

      props.toast.show({
        variant: "error",
        message,
        duration: 5000,
      })
    }),
    props.sdk.event.on(Installation.Event.UpdateAvailable.type, (evt) => {
      props.toast.show({
        variant: "info",
        title: "Update Available",
        message: `Terminal Agent v${evt.properties.version} is available. Run 'zeroxzero upgrade' to update manually.`,
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
