// Stdio entry point. Wires process.stdin/stdout to the Transport,
// then constructs the Server.

import { createServer, type ServerHandle } from "./server"
import { Transport } from "./transport"

function main() {
  const transport = new Transport(chunk => {
    process.stdout.write(chunk)
  })

  const server: ServerHandle = createServer(transport, {
    agentName: "claude-agent-server",
    agentVersion: "0.1.0",
  })

  let shuttingDown = false
  const shutdown = (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    // T2.6: cancel sessions, reject pending requests, then exit after a
    // brief drain window so stdout can flush.
    try {
      server.shutdownAll()
    } catch {
      // best-effort
    }
    setTimeout(() => process.exit(code), 100).unref()
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => {
    transport.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
  })
  process.stdin.on("end", () => shutdown(0))
  process.stdin.on("close", () => shutdown(0))
  process.stdin.on("error", () => shutdown(1))
  process.on("SIGTERM", () => shutdown(0))
  process.on("SIGINT", () => shutdown(0))
}

main()
