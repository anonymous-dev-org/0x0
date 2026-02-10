import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

function bootRoute(): SessionRoute {
  const raw = process.env["ZEROXZERO_ROUTE"]
  if (!raw) {
    return {
      type: "session",
      sessionID: "",
    }
  }
  const parsed = JSON.parse(raw)
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
    const [store, setStore] = createStore<SessionRoute>(bootRoute())

    return {
      get data() {
        return store
      },
      navigate(route: SessionRoute) {
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>
