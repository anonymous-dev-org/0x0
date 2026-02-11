import { Provider } from "@/provider/provider"
import { batch, createEffect, onMount } from "solid-js"
import type { Args } from "../context/args"
import { useLocal } from "../context/local"
import type { RouteContext } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"

export function useStartupNavigation(props: {
  args: Args
  local: ReturnType<typeof useLocal>
  route: RouteContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
}) {
  onMount(() => {
    batch(() => {
      if (props.args.agent) props.local.agent.set(props.args.agent)
      if (props.args.model) {
        const parsed = Provider.parseModel(props.args.model)
        if (!parsed.providerID || !parsed.modelID) {
          props.toast.show({
            variant: "warning",
            message: `Invalid model format: ${props.args.model}`,
            duration: 3000,
          })
          return
        }
        props.local.model.set({ providerID: parsed.providerID, modelID: parsed.modelID }, { recent: true })
      }
      if (props.args.sessionID && !props.args.fork) {
        props.route.navigate({
          type: "session",
          sessionID: props.args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    if (continued || props.sync.status === "loading" || !props.args.continue) return
    const match = props.sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (!match) return
    continued = true
    if (props.args.fork) {
      props.sdk.client.session.fork({ sessionID: match }).then((result) => {
        if (result.data?.id) {
          props.route.navigate({ type: "session", sessionID: result.data.id })
          return
        }
        props.toast.show({ message: "Failed to fork session", variant: "error" })
      })
      return
    }
    props.route.navigate({ type: "session", sessionID: match })
  })

  let forked = false
  createEffect(() => {
    if (forked || props.sync.status !== "complete" || !props.args.sessionID || !props.args.fork) return
    forked = true
    props.sdk.client.session.fork({ sessionID: props.args.sessionID }).then((result) => {
      if (result.data?.id) {
        props.route.navigate({ type: "session", sessionID: result.data.id })
        return
      }
      props.toast.show({ message: "Failed to fork session", variant: "error" })
    })
  })
}
