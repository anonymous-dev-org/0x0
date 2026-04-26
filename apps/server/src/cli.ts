import packageJson from "../package.json"
import { startServer } from "./server"

type RawModeInput = typeof process.stdin & {
  setRawMode?: (mode: boolean) => void
}

function printHelp() {
  console.log(`0x0 ${packageJson.version}

Usage:
  0x0 server [--port <port>] [--host <host>]
  0x0 --version
  0x0 --help

Commands:
  server    Start the local 0x0 server

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

async function ensureProviderKeys() {
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    return
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn("0x0 provider key not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.")
    return
  }

  console.log("0x0 needs OPENAI_API_KEY or ANTHROPIC_API_KEY to run model-backed providers.")
  console.log("Values entered here apply to this server process only.")
  const openAiApiKey = await readSecret("OPENAI_API_KEY (optional): ")
  const anthropicApiKey = await readSecret("ANTHROPIC_API_KEY (optional): ")

  if (openAiApiKey) {
    process.env.OPENAI_API_KEY = openAiApiKey
  }
  if (anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = anthropicApiKey
  }
  if (!openAiApiKey && !anthropicApiKey) {
    console.warn("No provider key configured. Provider requests will fail until a key is set.")
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

  if (command === "server") {
    await ensureProviderKeys()

    const portValue = readOption(args, "--port")
    let port: number | undefined
    if (portValue) {
      const parsedPort = Number(portValue)
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        throw new Error(`Invalid --port value: ${portValue}`)
      }
      port = parsedPort
    }
    await startServer({
      port,
      hostname: readOption(args, "--host"),
    })
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
