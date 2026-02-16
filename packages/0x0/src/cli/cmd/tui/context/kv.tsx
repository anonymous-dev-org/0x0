import { Global } from "@/global"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const file = Bun.file(path.join(Global.Path.state, "kv.json"))
    const pendingWrites: Record<string, any> = {}

    function persist() {
      return Bun.write(file, JSON.stringify(store, null, 2))
    }

    file
      .json()
      .then((x) => {
        if (!x || typeof x !== "object" || Array.isArray(x)) return
        setStore(x)

        for (const [key, value] of Object.entries(pendingWrites)) {
          setStore(key, value)
        }
      })
      .catch(() => {})
      .finally(() => {
        setReady(true)

        if (Object.keys(pendingWrites).length === 0) return
        for (const key of Object.keys(pendingWrites)) {
          delete pendingWrites[key]
        }
        void persist().catch(() => {})
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        if (!ready()) {
          pendingWrites[key] = store[key]
          return
        }
        void persist().catch(() => {})
      },
    }
    return result
  },
})
