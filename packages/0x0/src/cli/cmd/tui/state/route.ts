import { createStore } from "solid-js/store"
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

type RouteState = {
  readonly data: SessionRoute
  navigate(route: SessionRoute): void
}

let _state: RouteState

export function createRoute() {
  const [store, setStore] = createStore<SessionRoute>(bootRoute())

  _state = {
    get data() {
      return store
    },
    navigate(route: SessionRoute) {
      setStore(route)
    },
  }
}

export const route: RouteState = new Proxy({} as RouteState, {
  get: (_, key) => (_state as any)[key],
})

export type RouteContext = RouteState
