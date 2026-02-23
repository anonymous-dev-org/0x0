import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@/bus/bus-event"
import type { EventSource } from "./state/sdk"

declare global {
  const ZEROXZERO_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient, directory: string): EventSource {
  let subscriptions = 0
  let active = false

  return {
    on: (handler) => {
      const unsubscribe = client.on<Event>("event", handler)
      subscriptions += 1

      if (!active) {
        active = true
        void client.call("eventStart", { directory }).catch((error) => {
          Log.Default.error("failed to start event bridge", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }

      return () => {
        unsubscribe()
        subscriptions = Math.max(0, subscriptions - 1)
        if (subscriptions > 0 || !active) return

        active = false
        void client.call("eventStop", undefined).catch((error) => {
          Log.Default.error("failed to stop event bridge", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    },
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start 0x0 tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start 0x0 in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    const started = performance.now()
    const timing = (stage: string, extra?: Record<string, unknown>) => {
      Log.Default.debug("startup", {
        stage,
        elapsed_ms: Math.round(performance.now() - started),
        ...extra,
      })
    }

    timing("tui.thread.start")

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    const app = import("./app")

    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      if (typeof ZEROXZERO_WORKER_PATH !== "undefined") return ZEROXZERO_WORKER_PATH
      if (await Bun.file(distWorker).exists()) return distWorker
      return localWorker
    })
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    const worker = new Worker(workerPath, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    timing("tui.worker.spawned")
    worker.onerror = (e) => {
      Log.Default.error(e)
    }
    const client = Rpc.client<typeof rpc>(worker)
    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })
    process.on("SIGUSR2", async () => {
      await client.call("reload", undefined)
    })

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })
    timing("tui.prompt.resolved", { has_prompt: !!prompt })

    // Check if server should be started (port or hostname explicitly set in CLI or config)
    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    const events = createEventSource(client, cwd)

    if (shouldStartServer) {
      // Start HTTP server for external access
      const server = await client.call("server", networkOpts)
      url = server.url
      timing("tui.server.started")
    } else {
      // Use direct RPC communication (no HTTP)
      url = "http://zeroxzero.internal"
      customFetch = createWorkerFetch(client)
      timing("tui.rpc.mode")
    }

    const { tui } = await app

    const tuiPromise = tui({
      url,
      fetch: customFetch,
      events,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        fork: args.fork,
      },
      onExit: async () => {
        await client.call("shutdown", undefined)
      },
    })

    setTimeout(() => {
      client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)

    await tuiPromise
    timing("tui.thread.done")
  },
})
