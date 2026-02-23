import type { Server } from "./server"
import { hc } from "hono/client"

type AppType = Server.AppType

export type Client = ReturnType<typeof hc<AppType>>

export const hcWithType = (...args: Parameters<typeof hc<AppType>>): Client =>
  hc<AppType>(...args)
