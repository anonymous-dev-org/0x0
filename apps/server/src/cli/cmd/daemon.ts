import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Daemon } from "@/daemon/lifecycle"

export const DaemonCommand = cmd({
  command: "daemon <action>",
  describe: "manage background server daemon",
  builder: (yargs) =>
    withNetworkOptions(
      yargs.positional("action", {
        describe: "action to perform",
        choices: ["start", "stop", "status", "restart"] as const,
        demandOption: true,
      }),
    ),
  handler: async (args) => {
    const action = args.action as string

    switch (action) {
      case "start": {
        const opts = await resolveNetworkOptions(args)
        const { pid, port } = await Daemon.start(opts)
        console.log(`Daemon running (pid=${pid}, port=${port})`)
        break
      }

      case "stop": {
        const stopped = await Daemon.stop()
        console.log(stopped ? "Daemon stopped." : "No daemon running.")
        break
      }

      case "status": {
        const info = await Daemon.status()
        if (info.running) {
          console.log(`Daemon running (pid=${info.pid}, port=${info.port})`)
        } else {
          console.log("Daemon not running.")
        }
        break
      }

      case "restart": {
        await Daemon.stop()
        const opts = await resolveNetworkOptions(args)
        const { pid, port } = await Daemon.start(opts)
        console.log(`Daemon restarted (pid=${pid}, port=${port})`)
        break
      }
    }
  },
})
