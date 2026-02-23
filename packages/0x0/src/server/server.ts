import { NamedError } from "@anonymous-dev/0x0-util/error"
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { websocket } from "hono/bun"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { describeRoute, generateSpecs, openAPIRouteHandler, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../config/config"
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { Storage } from "../storage/storage"
import { lazy } from "../util/lazy"
import { Log } from "../util/log"
import { errors } from "./error"
import { MDNS } from "./mdns"
import { AppRoutes } from "./routes/app"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { FileRoutes } from "./routes/file"
import { GlobalRoutes } from "./routes/global"
import { McpRoutes } from "./routes/mcp"
import { PermissionRoutes } from "./routes/permission"
import { ProjectRoutes } from "./routes/project"
import { ProviderRoutes } from "./routes/provider"
import { PtyRoutes } from "./routes/pty"
import { QuestionRoutes } from "./routes/question"
import { SessionRoutes } from "./routes/session"
import { TuiRoutes } from "./routes/tui"
import { CompletionRoutes } from "./routes/completion"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  const app = new Hono()
  export const App = lazy(() =>
    app
      .onError((err, c) => {
        log.error("failed", {
          error: err,
        })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof Storage.NotFoundError) status = 404
          else if (err instanceof Provider.ModelNotFoundError) status = 400
          else if (err.name.startsWith("Worktree")) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        if (err instanceof HTTPException) return err.getResponse()
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), {
          status: 500,
        })
      })
      .use(async (c, next) => {
        let config: Config.Info
        try {
          config = await Config.get()
        } catch {
          // Config.get() needs Instance context which may not be ready yet
          // during early startup. Skip auth in that case.
          return next()
        }
        const password = config.server?.password
        if (!password) return next()
        const username = config.server?.username ?? "zeroxzero"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/log"
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
            if (_corsWhitelist.includes(input)) {
              return input
            }

            return
          },
        })
      )
      .route("/global", GlobalRoutes())
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        const raw = c.req.query("directory") || c.req.header("x-zeroxzero-directory") || process.cwd()
        const directory = (() => {
          try {
            return decodeURIComponent(raw)
          } catch {
            return raw
          }
        })()
        return Instance.provide({
          directory,
          init: InstanceBootstrap,
          async fn() {
            return next()
          },
        })
      })
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "zeroxzero",
              version: "0.0.3",
              description: "zeroxzero api",
            },
            openapi: "3.1.1",
          },
        })
      )
      .use(validator("query", z.object({ directory: z.string().optional() })))
      .route("/project", ProjectRoutes())
      .route("/pty", PtyRoutes())
      .route("/config", ConfigRoutes())
      .route("/experimental", ExperimentalRoutes())
      .route("/session", SessionRoutes())
      .route("/permission", PermissionRoutes())
      .route("/question", QuestionRoutes())
      .route("/provider", ProviderRoutes())
      .route("/", FileRoutes())
      .route("/mcp", McpRoutes())
      .route("/tui", TuiRoutes())
      .route("/completion", CompletionRoutes())
      .route("/", AppRoutes())
  )

  export type AppType = ReturnType<typeof App>

  export async function openapi() {
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "zeroxzero",
          version: "1.0.0",
          description: "zeroxzero api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    _corsWhitelist = opts.cors ?? []

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App().fetch,
      websocket: websocket,
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

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
