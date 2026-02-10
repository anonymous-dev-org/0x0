import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type Route = SessionRoute

function bootRoute(): Route {
  const raw = process.env["ZEROXZERO_ROUTE"]
  if (!raw) {
    return {
      type: "session",
      sessionID: "",
    }
  }
  const parsed = JSON.parse(raw)
  if (parsed?.type === "home") {
    return {
      type: "session",
      sessionID: "",
      initialPrompt: parsed.initialPrompt,
    }
  }
  if (parsed?.type === "session") {
    return {
      type: "session",
      sessionID: parsed.sessionID ?? "",
      initialPrompt: parsed.initialPrompt,
    }
  }
  return {
    type: "session",
    sessionID: "",
  }
}

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(bootRoute())

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
