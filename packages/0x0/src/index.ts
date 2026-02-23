import yargs, { type Argv, type ArgumentsCamelCase, type CommandModule } from "yargs"
import { hideBin } from "yargs/helpers"
import { Log } from "./util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@anonymous-dev/0x0-util/error"
import { EOL } from "os"

type BaseArgs = Record<string, unknown>
type LazyCommand = CommandModule<BaseArgs, BaseArgs>
const started = performance.now()
const args = hideBin(process.argv)
const shouldForceExit = !args.some((x) => x === "--help" || x === "-h" || x === "--version" || x === "-v")

function timing(stage: string, extra?: Record<string, unknown>) {
  Log.Default.debug("startup", {
    stage,
    elapsed_ms: Math.round(performance.now() - started),
    ...extra,
  })
}

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
    const now = performance.now()
    command = load().then((value) => {
      timing("command.loaded", {
        command: Array.isArray(config.command) ? config.command.join(" ") : config.command,
        duration_ms: Math.round(performance.now() - now),
      })
      return value
    })
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
      command: "acp",
      describe: "start ACP (Agent Client Protocol) server",
    },
    command(() => import("./cli/cmd/acp"), "AcpCommand"),
  ),
  lazy(
    {
      command: "mcp",
      describe: "manage MCP (Model Context Protocol) servers",
    },
    command(() => import("./cli/cmd/mcp"), "McpCommand"),
  ),
  lazy(
    {
      command: "$0 [project]",
      describe: "start 0x0 tui",
    },
    command(() => import("./cli/cmd/tui/thread"), "TuiThreadCommand"),
  ),
  lazy(
    {
      command: "attach <url>",
      describe: "attach to a running 0x0 server",
    },
    command(() => import("./cli/cmd/tui/attach"), "AttachCommand"),
  ),
  lazy(
    {
      command: "run [message..]",
      describe: "run 0x0 with a message",
    },
    command(() => import("./cli/cmd/run"), "RunCommand"),
  ),
  lazy(
    {
      command: "generate",
    },
    command(() => import("./cli/cmd/generate"), "GenerateCommand"),
  ),
  lazy(
    {
      command: "debug",
      describe: "debugging and troubleshooting tools",
    },
    command(() => import("./cli/cmd/debug"), "DebugCommand"),
  ),
  lazy(
    {
      command: "agent",
      describe: "manage agents",
    },
    command(() => import("./cli/cmd/agent"), "AgentCommand"),
  ),
  lazy(
    {
      command: "upgrade [target]",
      describe: "upgrade 0x0 to the latest or a specific version",
    },
    command(() => import("./cli/cmd/upgrade"), "UpgradeCommand"),
  ),
  lazy(
    {
      command: "uninstall",
      describe: "uninstall 0x0 and remove all related files",
    },
    command(() => import("./cli/cmd/uninstall"), "UninstallCommand"),
  ),
  lazy(
    {
      command: "server",
      aliases: ["serve"],
      describe: "starts a headless 0x0 server",
    },
    command(() => import("./cli/cmd/serve"), "ServeCommand"),
  ),
  lazy(
    {
      command: "models [provider]",
      describe: "list all available models",
    },
    command(() => import("./cli/cmd/models"), "ModelsCommand"),
  ),
  lazy(
    {
      command: "stats",
      describe: "show token usage and cost statistics",
    },
    command(() => import("./cli/cmd/stats"), "StatsCommand"),
  ),
  lazy(
    {
      command: "export [sessionID]",
      describe: "export session data as JSON",
    },
    command(() => import("./cli/cmd/export"), "ExportCommand"),
  ),
  lazy(
    {
      command: "import <file>",
      describe: "import shared data from URL or local file",
    },
    command(() => import("./cli/cmd/import"), "ImportCommand"),
  ),
  lazy(
    {
      command: "github",
      describe: "manage GitHub agent",
    },
    command(() => import("./cli/cmd/github"), "GithubCommand"),
  ),
  lazy(
    {
      command: "pr <number>",
      describe: "fetch and checkout a GitHub PR branch, then run 0x0",
    },
    command(() => import("./cli/cmd/pr"), "PrCommand"),
  ),
  lazy(
    {
      command: "session",
      describe: "manage sessions",
    },
    command(() => import("./cli/cmd/session"), "SessionCommand"),
  ),
]

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
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
    timing("log.init")

    process.env.AGENT = "1"
    process.env.ZEROXZERO = "1"

    Log.Default.info("zeroxzero", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
    timing("middleware.ready")
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
  timing("parse.completed")
} catch (e) {
  timing("parse.failed")
  let data: Record<string, unknown> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const loaded = performance.now()
  const { FormatError } = await import("./cli/error")
  timing("error.formatter.loaded", {
    duration_ms: Math.round(performance.now() - loaded),
  })
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  if (shouldForceExit) process.exit()
}
