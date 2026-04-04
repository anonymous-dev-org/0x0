import { NamedError } from "@/util/error"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"
import { HTTPException } from "hono/http-exception"
import { basicAuth } from "hono/basic-auth"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import z from "zod"
import { Config } from "@/core/config/config"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { SessionStore } from "@/session/store"
import {
  SessionNotFoundError,
  SessionBusyError,
  ProviderUnavailableError,
  UnsupportedProviderOptionsError,
} from "./error"
import { MessageRoutes } from "./routes/messages"
import { SessionRoutes } from "./routes/sessions"
import { ProviderRoutes } from "./routes/providers"
import { CompletionRoutes } from "./routes/completions"
import { WorkgroupRoutes } from "./routes/workgroup"

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []
  let _cleanupTimer: ReturnType<typeof setInterval> | undefined

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  const app = new Hono()
  export const App = lazy(() =>
    app
      .use(trimTrailingSlash())
      .onError((err, c) => {
        log.error("failed", { error: err })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof SessionNotFoundError) status = 404
          else if (err instanceof SessionBusyError) status = 409
          else if (err instanceof ProviderUnavailableError) status = 503
          else if (err instanceof UnsupportedProviderOptionsError) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        if (err instanceof z.ZodError) {
          return c.json(
            new NamedError.Unknown({ message: err.message }).toObject(),
            { status: 400 },
          )
        }
        if (err instanceof HTTPException) return err.getResponse()
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), { status: 500 })
      })
      .use(async (c, next) => {
        let config: Config.Info
        try {
          config = await Config.get()
        } catch {
          return next()
        }
        const password = config.server?.password
        if (!password) return next()
        const username = config.server?.username ?? "zeroxzero"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/health"
        if (!skipLogging) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skipLogging) {
          timer.stop()
        }
      })
      .use(
        cors({
          origin(input) {
            if (!input) return
            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (_corsWhitelist.includes(input)) return input
            return
          },
        }),
      )
      .get("/health", (c) =>
        c.json({ ok: true, sessions: SessionStore.count() }),
      )
      .route("/messages", MessageRoutes())
      .route("/sessions", SessionRoutes())
      .route("/providers", ProviderRoutes())
      .route("/completions", CompletionRoutes())
      .route("/workgroup", WorkgroupRoutes()),
  )

  export type AppType = ReturnType<typeof App>

  export function listen(opts: {
    port: number
    hostname: string
    cors?: string[]
  }) {
    _corsWhitelist = opts.cors ?? []

    // Start session cleanup timer (every 5 minutes)
    if (_cleanupTimer) clearInterval(_cleanupTimer)
    _cleanupTimer = setInterval(() => SessionStore.cleanup(60), 5 * 60 * 1000)

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App().fetch,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    return server
  }
}
