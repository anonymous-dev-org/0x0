import { Server } from "@/server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Config } from "@/core/config/config"
import { PidFile } from "@/daemon/pid"

export const ServeCommand = cmd({
  command: "server",
  aliases: ["serve"],
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start the 0x0 API server",
  handler: async (args) => {
    const config = await Config.global()
    if (!config.server?.password) {
      console.log("Warning: server.password is not set in config; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)

    const isDaemon = process.env.ZEROXZERO_DAEMON === "1"
    if (isDaemon) {
      await PidFile.write({ pid: process.pid, port: server.port! })
    }

    console.log(`0x0 server listening on http://${server.hostname}:${server.port}`)

    await new Promise<void>((resolve) => {
      const shutdown = () => resolve()
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
    })

    if (isDaemon) {
      await PidFile.remove()
    }
    await server.stop()
  },
})
