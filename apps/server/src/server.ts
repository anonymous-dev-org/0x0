import { createApp } from "./app"
import { createProviderRegistry } from "./providers"
import { createWebSocketHandler } from "./ws"
import { WorktreeManager } from "./worktree"

export type StartServerOptions = {
  port?: number
  hostname?: string
}

export async function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4096)
  const hostname = options.hostname ?? "127.0.0.1"
  const registry = createProviderRegistry({
    openAiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  })
  const worktrees = new WorktreeManager()
  await worktrees.loadSessions()
  const app = createApp(registry, worktrees)
  const websocket = createWebSocketHandler(registry, worktrees)

  const server = Bun.serve({
    port,
    hostname,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/ws" && server.upgrade(request, { data: undefined })) {
        return undefined
      }

      return app.fetch(request)
    },
    websocket,
  })

  console.log(`0x0 server listening on http://${hostname}:${server.port}`)

  return server
}
