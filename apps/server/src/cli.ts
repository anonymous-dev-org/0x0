import packageJson from "../package.json"
import { readFile } from "node:fs/promises"
import { CONFIG_PATH, hasProviderKey, LOG_PATH, readServerConfig, writeServerConfig, applyProviderEnv } from "./config"
import { startDaemon, statusServer, stopDaemon, logPathExists } from "./daemon"
import { startServer } from "./server"

type RawModeInput = typeof process.stdin & {
  setRawMode?: (mode: boolean) => void
}

function printHelp() {
  console.log(`0x0 ${packageJson.version}

Usage:
  0x0 init
  0x0 server [--port <port>] [--host <host>]
  0x0 serve [--port <port>] [--host <host>]
  0x0 status [--port <port>] [--host <host>]
  0x0 stop [--port <port>] [--host <host>]
  0x0 restart [--port <port>] [--host <host>]
  0x0 logs
  0x0 --version
  0x0 --help

Commands:
  init      Store provider keys in ${CONFIG_PATH}
  server    Start the local 0x0 server in the background
  serve     Run the local 0x0 server in the foreground
  status    Print server status
  stop      Stop the background server
  restart   Restart the background server
  logs      Print the background server log

Options:
  --port    Port to listen on. Defaults to PORT or 4096.
  --host    Hostname to bind. Defaults to 127.0.0.1.
`)
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}

async function readSecret(prompt: string) {
  const stdin = process.stdin as RawModeInput
  if (!stdin.isTTY || !process.stdout.isTTY) {
    return ""
  }

  process.stdout.write(prompt)
  stdin.resume()
  stdin.setRawMode?.(true)

  let value = ""
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      process.stdout.write("\n")
    }

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte)
        if (char === "\r" || char === "\n") {
          cleanup()
          resolve(value)
          return
        }
        if (char === "\u0003") {
          cleanup()
          reject(new Error("Cancelled."))
          return
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }

    stdin.on("data", onData)
  })
}

async function ensureProviderKeys(options: { forcePrompt?: boolean } = {}) {
  const existing = await readServerConfig()
  if (!options.forcePrompt && hasProviderKey(existing)) {
    return existing
  }

  const envConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || existing.openAiApiKey,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || existing.anthropicApiKey,
  }
  if (!options.forcePrompt && hasProviderKey(envConfig)) {
    return envConfig
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (options.forcePrompt && hasProviderKey(envConfig)) {
      await writeServerConfig(envConfig)
      return envConfig
    }
    throw new Error("0x0 provider key not configured. Run `0x0 init` or set OPENAI_API_KEY or ANTHROPIC_API_KEY.")
  }

  console.log("0x0 needs OPENAI_API_KEY or ANTHROPIC_API_KEY to run model-backed providers.")
  console.log(`Values entered here are stored in ${CONFIG_PATH}.`)
  const openAiApiKey = await readSecret("OPENAI_API_KEY (optional): ")
  const anthropicApiKey = await readSecret("ANTHROPIC_API_KEY (optional): ")

  if (!openAiApiKey && !anthropicApiKey && !hasProviderKey(envConfig)) {
    throw new Error("At least one provider key is required.")
  }

  const config = {
    openAiApiKey: openAiApiKey || envConfig.openAiApiKey,
    anthropicApiKey: anthropicApiKey || envConfig.anthropicApiKey,
  }
  await writeServerConfig(config)
  return config
}

function readServerOptions(args: string[]) {
  const portValue = readOption(args, "--port")
  let port: number | undefined
  if (portValue) {
    const parsedPort = Number(portValue)
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      throw new Error(`Invalid --port value: ${portValue}`)
    }
    port = parsedPort
  }

  return {
    port,
    hostname: readOption(args, "--host"),
  }
}

async function main() {
  const args = Bun.argv.slice(2)
  const command = args[0]

  if (!command || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "--version" || command === "-v") {
    console.log(packageJson.version)
    return
  }

  if (command === "init") {
    await ensureProviderKeys({ forcePrompt: true })
    console.log(`0x0 provider config saved to ${CONFIG_PATH}`)
    return
  }

  if (command === "server") {
    const options = readServerOptions(args)
    const config = await ensureProviderKeys()
    const status = await startDaemon(config, options)
    console.log(`0x0 server running at ${status.url}${status.pid ? ` (pid ${status.pid})` : ""}`)
    return
  }

  if (command === "serve") {
    const options = readServerOptions(args)
    const config = await ensureProviderKeys()
    applyProviderEnv(config)
    await startServer(options)
    return
  }

  if (command === "status") {
    const status = await statusServer(readServerOptions(args))
    console.log(status.running ? `running ${status.url}${status.pid ? ` pid=${status.pid}` : ""}` : `stopped ${status.url}`)
    return
  }

  if (command === "stop") {
    const stopped = await stopDaemon(readServerOptions(args))
    console.log(stopped ? "0x0 server stopped" : "0x0 server is not running")
    return
  }

  if (command === "restart") {
    const options = readServerOptions(args)
    await stopDaemon(options).catch(() => undefined)
    const config = await ensureProviderKeys()
    const status = await startDaemon(config, options)
    console.log(`0x0 server running at ${status.url}${status.pid ? ` (pid ${status.pid})` : ""}`)
    return
  }

  if (command === "logs") {
    if (!logPathExists()) {
      console.log(`No 0x0 server log found at ${LOG_PATH}`)
      return
    }
    console.log(await readFile(LOG_PATH, "utf8"))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
