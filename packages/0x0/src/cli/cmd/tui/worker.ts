import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { Bus } from "@/bus"
import type { Event } from "@/bus/bus-event"
import type { BunWebSocketData } from "hono/bun"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Bun.Server<BunWebSocketData> | undefined

const eventBridge = {
  abort: undefined as AbortController | undefined,
  unsubscribe: undefined as (() => void) | undefined,
}

const startup = {
  started: performance.now(),
}

function timing(stage: string, extra?: Record<string, unknown>) {
  Log.Default.debug("startup", {
    stage,
    elapsed_ms: Math.round(performance.now() - startup.started),
    ...extra,
  })
}

function stopEventBridge() {
  if (eventBridge.abort) {
    eventBridge.abort.abort()
    eventBridge.abort = undefined
  }
  if (eventBridge.unsubscribe) {
    eventBridge.unsubscribe()
    eventBridge.unsubscribe = undefined
  }
}

const startDirectEventBridge = async (directory: string) => {
  timing("worker.event_bridge.start", { directory })
  stopEventBridge()

  const abort = new AbortController()
  eventBridge.abort = abort
  const signal = abort.signal

  await Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      if (signal.aborted) return
      Rpc.emit("event", {
        type: "server.connected",
        properties: {},
      })

      const unsubscribe = Bus.subscribeAll((event) => {
        Rpc.emit("event", event as Event)
        if (event.type !== Bus.InstanceDisposed.type) return
        if (signal.aborted) return
        timing("worker.event_bridge.rebind", { directory })
        queueMicrotask(() => {
          void startDirectEventBridge(directory)
        })
      })

      if (signal.aborted) {
        unsubscribe()
        return
      }

      const cleanup = () => {
        unsubscribe()
        if (eventBridge.unsubscribe === cleanup) eventBridge.unsubscribe = undefined
      }
      eventBridge.unsubscribe = cleanup

      timing("worker.event_bridge.connected", { directory })
    },
  }).catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

timing("worker.ready")

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = await getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.App().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async eventStart(input: { directory: string }) {
    await startDirectEventBridge(input.directory)
  },
  async eventStop() {
    stopEventBridge()
  },
  async reload() {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    stopEventBridge()
    await Instance.disposeAll()
    if (server) server.stop(true)
  },
}

Rpc.listen(rpc)

async function getAuthorizationHeader(): Promise<string | undefined> {
  try {
    const config = await Config.get()
    const password = config.server?.password
    if (!password) return undefined
    const username = config.server?.username ?? "zeroxzero"
    return `Basic ${btoa(`${username}:${password}`)}`
  } catch {
    // Config.get() needs Instance context which may not be available yet
    // during early startup. Skip auth header in that case.
    return undefined
  }
}
