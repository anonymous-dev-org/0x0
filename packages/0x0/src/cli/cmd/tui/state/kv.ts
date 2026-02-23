import { Global } from "@/global"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import path from "path"

type KVState = {
  readonly ready: boolean
  readonly store: Record<string, any>
  signal<T>(name: string, defaultValue: T): readonly [() => T, (next: Setter<T>) => void]
  get(key: string, defaultValue?: any): any
  set(key: string, value: any): void
}

let _state: KVState

export function createKV() {
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

  _state = {
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
          return _state.get(name)
        },
        function setter(next: Setter<T>) {
          _state.set(name, next)
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
}

export const kv: KVState = new Proxy({} as KVState, {
  get: (_, key) => (_state as any)[key],
})
