import yargs, { type Argv, type ArgumentsCamelCase, type CommandModule } from "yargs"
import { hideBin } from "yargs/helpers"
import { Log } from "./util/log"
import { UI } from "./cli/ui"
import { Installation } from "./core/installation"
import { NamedError } from "@/util/error"
import { EOL } from "os"

type BaseArgs = Record<string, unknown>
type LazyCommand = CommandModule<BaseArgs, BaseArgs>
const args = hideBin(process.argv)
const shouldForceExit = !args.some((x) => x === "--help" || x === "-h" || x === "--version" || x === "-v")

function lazy(
  config: {
    command: string | readonly string[]
    describe?: string
    aliases?: string | readonly string[]
  },
  load: () => Promise<LazyCommand>,
): LazyCommand {
  let command: Promise<LazyCommand> | undefined
  const get = () => {
    if (command) return command
    command = load()
    return command
  }

  return {
    command: config.command,
    describe: config.describe,
    aliases: config.aliases,
    builder: async (argv: Argv<BaseArgs>) => {
      const loaded = await get()
      if (!loaded.builder) return argv
      if (typeof loaded.builder !== "function") return argv.options(loaded.builder)
      const built = await loaded.builder(argv as never)
      if (!built) return argv
      return built as Argv<BaseArgs>
    },
    handler: async (argv: ArgumentsCamelCase<BaseArgs>) => {
      const loaded = await get()
      await loaded.handler(argv as never)
    },
  }
}

function command(input: () => Promise<Record<string, unknown>>, key: string) {
  return async () => {
    const mod = await input()
    const loaded = mod[key]
    if (!loaded) throw new Error(`Failed to load command ${key}`)
    return loaded as LazyCommand
  }
}

const commands = [
  lazy(
    {
      command: "$0",
      aliases: ["serve"],
      describe: "start 0x0 API server",
    },
    command(() => import("./cli/cmd/serve"), "ServeCommand"),
  ),
  lazy(
    {
      command: "daemon <action>",
      describe: "manage background server daemon",
    },
    command(() => import("./cli/cmd/daemon"), "DaemonCommand"),
  ),
]

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : String(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : String(e),
  })
})

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("0x0")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Log.Default.info("zeroxzero-server", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  .command(commands)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, unknown> = {}
  if (e instanceof NamedError) {
    Object.assign(data, e.toObject().data)
  }
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }
  Log.Default.error("fatal", data)
  const { FormatError } = await import("./cli/error")
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  if (shouldForceExit) process.exit()
}
