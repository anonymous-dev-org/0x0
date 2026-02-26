import { cmd } from "@anonymous-dev/0x0-server/cli/cmd/cmd"
import path from "path"
import { UI } from "@anonymous-dev/0x0-server/cli/ui"
import { Log } from "@anonymous-dev/0x0-server/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@anonymous-dev/0x0-server/cli/network"
import { Config } from "@anonymous-dev/0x0-server/config/config"
import type { Event } from "@anonymous-dev/0x0-server/bus/bus-event"
import type { EventSource } from "./state/sdk"
import { Daemon } from "../daemon"

function createHTTPEventSource(baseUrl: string, directory: string, headers?: Record<string, string>): EventSource {
  return {
    on: (handler) => {
      const abort = new AbortController()
      const url = new URL("/event", baseUrl)
      url.searchParams.set("directory", directory)

      const connect = async () => {
        while (!abort.signal.aborted) {
          try {
            const res = await fetch(url.href, {
              headers: { Accept: "text/event-stream", ...headers },
              signal: abort.signal,
            })
            if (!res.body) return
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  try {
                    handler(JSON.parse(line.slice(6)))
                  } catch {}
                }
              }
            }
          } catch {
            if (abort.signal.aborted) return
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      }
      void connect()
      return () => {
        abort.abort()
      }
    },
  }
}

async function getAuthHeaders(): Promise<Record<string, string> | undefined> {
  try {
    const cfg = await Config.getGlobal()
    const password = cfg.server?.password
    if (!password) return undefined
    const username = cfg.server?.username ?? "zeroxzero"
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
  } catch {
    return undefined
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
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })

    // Resolve prompt from stdin pipe and/or --prompt flag
    const prompt = await (async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })()
    timing("tui.prompt.resolved", { has_prompt: !!prompt })

    // Start daemon (or discover existing)
    const networkOpts = await resolveNetworkOptions(args)
    const { url } = await Daemon.start({
      port: networkOpts.port || undefined,
      hostname: networkOpts.hostname !== "127.0.0.1" ? networkOpts.hostname : undefined,
    })
    timing("tui.daemon.ready")

    // Get auth headers
    const headers = await getAuthHeaders()

    // Create HTTP SSE event source
    const events = createHTTPEventSource(url, cwd, headers)

    // SIGUSR2 → reload daemon via HTTP
    process.on("SIGUSR2", async () => {
      await fetch(new URL("/global/reload", url), {
        method: "POST",
        headers,
      }).catch(() => {})
    })

    const { tui } = await app

    const tuiPromise = tui({
      url,
      headers,
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
        // Daemon persists — nothing to clean up
      },
    })

    await tuiPromise
    timing("tui.thread.done")
  },
})
