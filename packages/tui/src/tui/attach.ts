import { cmd } from "@anonymous-dev/0x0-server/cli/cmd/cmd"
import { tui } from "./app"
import { Config } from "@anonymous-dev/0x0-server/config/config"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running 0x0 server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to server.password in config.yaml)",
      }),
  handler: async (args) => {
    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()
    const headers = await (async () => {
      const cfg = await Config.getGlobal()
      const password = args.password ?? cfg.server?.password
      if (!password) return undefined
      const username = cfg.server?.username ?? "zeroxzero"
      const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      return { Authorization: auth }
    })()
    await tui({
      url: args.url,
      args: { sessionID: args.session },
      directory,
      headers,
    })
  },
})
