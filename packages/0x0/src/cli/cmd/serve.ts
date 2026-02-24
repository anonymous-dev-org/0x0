import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Config } from "../../config/config"

export const ServeCommand = cmd({
  command: "server",
  aliases: ["serve"],
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless 0x0 server",
  handler: async (args) => {
    const config = await Config.global()
    if (!config.server?.password) {
      console.log("Warning: server.password is not set in config.yaml; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`0x0 server listening on http://${server.hostname}:${server.port}`)
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        resolve()
      }
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
    })
    await server.stop()
  },
})
