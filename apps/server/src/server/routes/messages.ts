import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { ProviderRegistry } from "@/provider/registry"
import { SessionStore } from "@/session/store"
import {
  SessionNotFoundError,
  SessionBusyError,
  UnsupportedProviderOptionsError,
} from "../error"
import { Log } from "@/util/log"

const log = Log.create({ service: "messages" })

const MessageInput = z.object({
  prompt: z.string().min(1),
  provider: z.string().optional(),
  session_id: z.string().uuid().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
  system_prompt: z.string().optional(),
  append_system_prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  permission_mode: z.string().optional(),
  sandbox: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  stream: z.boolean().default(true),
}).strict()

export function MessageRoutes() {
  return new Hono()
    .post("/", async (c) => {
      const body = MessageInput.parse(await c.req.json())

      // Resolve session if provided
      let session = body.session_id ? SessionStore.get(body.session_id) : undefined
      if (body.session_id && !session) {
        throw new SessionNotFoundError({ id: body.session_id })
      }
      if (session?.status === "busy") {
        throw new SessionBusyError({ id: session.id })
      }

      // Resolve provider
      const providerId = body.provider ?? session?.provider
      const provider = await ProviderRegistry.resolve(providerId)

      const unsupportedOptions = Object.entries(body)
        .filter(([key, value]) =>
          value !== undefined &&
          key !== "provider" &&
          !provider.supportedMessageOptions.includes(key),
        )
        .map(([key]) => key)

      if (unsupportedOptions.length > 0) {
        throw new UnsupportedProviderOptionsError({
          provider: provider.id,
          options: unsupportedOptions,
          supported_options: [...provider.supportedMessageOptions],
        })
      }

      // Create session if not provided (for conversation tracking)
      if (!session) {
        session = SessionStore.create(provider.id)
      }

      SessionStore.setBusy(session.id)
      const sessionId = session.id

      log.info("message", { session: sessionId, provider: provider.id })

      const spawnInput = {
        prompt: body.prompt,
        sessionId: session.providerSessionId,
        model: body.model,
        effort: body.effort,
        modelReasoningEffort: body.model_reasoning_effort,
        systemPrompt: body.system_prompt,
        appendSystemPrompt: body.append_system_prompt,
        allowedTools: body.allowed_tools,
        disallowedTools: body.disallowed_tools,
        permissionMode: body.permission_mode,
        sandbox: body.sandbox,
        maxTurns: body.max_turns,
        cwd: body.cwd,
      }

      if (body.stream) {
        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())

          let providerSessionId: string | undefined

          try {
            for await (const event of provider.spawn({ ...spawnInput, abort: ac.signal })) {
              if (event.type === "init" && event.session_id) {
                providerSessionId = event.session_id
              }
              if (event.type === "result" && event.session_id) {
                providerSessionId = event.session_id
              }

              await sseStream.writeSSE({
                data: JSON.stringify({ ...event, session_id: event.type === "init" ? sessionId : undefined }),
              })
            }
          } finally {
            SessionStore.setIdle(sessionId, providerSessionId)
          }
        })
      }

      // Non-streaming: buffer result
      let resultText = ""
      let providerSessionId: string | undefined
      let costUsd: number | undefined
      let durationMs: number | undefined

      try {
        for await (const event of provider.spawn(spawnInput)) {
          if (event.type === "text_delta") resultText += event.text
          if (event.type === "result") {
            providerSessionId = event.session_id
            costUsd = event.cost_usd
            durationMs = event.duration_ms
            if (event.result) resultText = event.result
          }
        }
      } finally {
        SessionStore.setIdle(sessionId, providerSessionId)
      }

      return c.json({
        session_id: sessionId,
        result: resultText,
        cost_usd: costUsd,
        duration_ms: durationMs,
      })
    })
}
