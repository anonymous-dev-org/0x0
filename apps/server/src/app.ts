import {
  ChatRequestSchema,
  ChatResponseSchema,
  CompletionRequestSchema,
  CompletionResponseSchema,
  HealthResponseSchema,
  InlineEditRequestSchema,
  InlineEditResponseSchema,
  ProvidersResponseSchema,
  type Session,
  SessionsResponseSchema,
} from "@anonymous-dev/0x0-contracts"
import type { Context } from "hono"
import { Hono } from "hono"
import { toCompletionChatRequest, toInlineEditChatRequest } from "./one-shot"
import { createProviderRegistry, type ProviderRegistry } from "./providers"
import { createSseResponse } from "./sse"
import { type SessionRecord, WorktreeManager } from "./worktree"

type HttpSessionManager = {
  listSessions(): SessionRecord[]
  getSession(sessionId: string): SessionRecord | undefined
  deleteSession(sessionId: string): Promise<void>
}

type AppBindings = {
  Variables: {
    providers: ProviderRegistry
  }
}

function publicSession(session: SessionRecord): Session {
  return {
    id: session.id,
    repoRoot: session.repoRoot,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    messages: session.messages,
  }
}

async function handleChatRequest(c: Context<AppBindings>) {
  const input = ChatRequestSchema.parse(await c.req.json())
  const provider = c.get("providers")[input.provider]

  if (!provider.info.configured) {
    return c.json(
      {
        error: `${provider.info.label} is not configured on the server.`,
      },
      400
    )
  }

  if (input.stream) {
    return createSseResponse(provider.stream(input, c.req.raw.signal))
  }

  const response = await provider.complete(input, c.req.raw.signal)
  return c.json(ChatResponseSchema.parse(response))
}

export function createApp(
  registry = createProviderRegistry({
    codexCommand: process.env.ZEROXZERO_CODEX_ACP_COMMAND,
    claudeCommand: process.env.ZEROXZERO_CLAUDE_ACP_COMMAND,
  }),
  sessions: HttpSessionManager = new WorktreeManager()
) {
  const app = new Hono<AppBindings>()

  app.use(async (c, next) => {
    c.set("providers", registry)
    await next()
  })

  app.onError((error, c) => {
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      500
    )
  })

  app.get("/health", c => c.json(HealthResponseSchema.parse({ ok: true })))

  app.get("/providers", c => {
    const providers = Object.values(c.get("providers")).map(provider => provider.info)
    return c.json(ProvidersResponseSchema.parse({ providers }))
  })

  app.get("/sessions", c => {
    return c.json(
      SessionsResponseSchema.parse({
        sessions: sessions.listSessions().map(publicSession),
      })
    )
  })

  app.get("/sessions/:id", c => {
    const session = sessions.getSession(c.req.param("id"))
    if (!session) {
      return c.json({ error: "Session not found." }, 404)
    }
    return c.json(publicSession(session))
  })

  app.delete("/sessions/:id", async c => {
    const session = sessions.getSession(c.req.param("id"))
    if (!session) {
      return c.json({ error: "Session not found." }, 404)
    }
    await sessions.deleteSession(session.id)
    return c.json(publicSession(session))
  })

  app.post("/chat", handleChatRequest)
  app.post("/messages", handleChatRequest)

  app.post("/completions", async c => {
    const input = CompletionRequestSchema.parse(await c.req.json())
    const request = toCompletionChatRequest(c.get("providers"), {
      ...input,
      stream: false,
    })
    const provider = c.get("providers")[request.provider]

    if (!provider.info.configured) {
      return c.json(
        {
          error: `${provider.info.label} is not configured on the server.`,
        },
        400
      )
    }

    const response = await provider.complete(request, c.req.raw.signal)
    return c.json(CompletionResponseSchema.parse(response))
  })

  app.post("/inline-edit", async c => {
    const input = InlineEditRequestSchema.parse(await c.req.json())
    const request = toInlineEditChatRequest(c.get("providers"), input)
    const provider = c.get("providers")[request.provider]

    if (!provider.info.configured) {
      return c.json(
        {
          error: `${provider.info.label} is not configured on the server.`,
        },
        400
      )
    }

    const response = await provider.complete(request, c.req.raw.signal)
    return c.json(InlineEditResponseSchema.parse({ replacementText: response.text }))
  })

  return app
}

export type AppType = ReturnType<typeof createApp>
