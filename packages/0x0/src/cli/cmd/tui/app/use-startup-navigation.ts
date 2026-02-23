import { Provider } from "@/provider/provider"
import { batch, createEffect, onMount } from "solid-js"
import { args } from "@tui/state/args"
import { local } from "@tui/state/local"
import { route } from "@tui/state/route"
import { sdk } from "@tui/state/sdk"
import { sync } from "@tui/state/sync"
import { useToast } from "../ui/toast"

export function useStartupNavigation() {
  const toast = useToast()

  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const parsed = Provider.parseModel(args.model)
        if (!parsed.providerID || !parsed.modelID) {
          toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
          return
        }
        local.model.set({ providerID: parsed.providerID, modelID: parsed.modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    if (continued || sync.status === "loading" || !args.continue) return
    if (sync.data.session.length === 0) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (!match) return
    continued = true
    if (args.fork) {
      sdk.client.session[":sessionID"].fork.$post({ param: { sessionID: match }, json: {} } as any).then((res: any) => res.json()).then((result: any) => {
        if (result?.id) {
          route.navigate({ type: "session", sessionID: result.id })
          return
        }
        toast.show({ message: "Failed to fork session", variant: "error" })
      })
      return
    }
    route.navigate({ type: "session", sessionID: match })
  })

  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    sdk.client.session[":sessionID"].fork.$post({ param: { sessionID: args.sessionID }, json: {} } as any).then((res: any) => res.json()).then((result: any) => {
      if (result?.id) {
        route.navigate({ type: "session", sessionID: result.id })
        return
      }
      toast.show({ message: "Failed to fork session", variant: "error" })
    })
  })
}
