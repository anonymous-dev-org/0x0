import packageJson from "../package.json"
import { startServer } from "./server"

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
