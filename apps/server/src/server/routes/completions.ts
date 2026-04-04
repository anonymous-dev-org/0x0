import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { CompletionRegistry } from "@/provider/completion/registry"
import { Log } from "@/util/log"

const log = Log.create({ service: "completions" })

const CompletionInput = z
  .object({
    prefix: z.string(),
    suffix: z.string().default(""),
    language: z.string().default(""),
    filepath: z.string().default(""),
    max_tokens: z.number().int().positive().default(128),
    temperature: z.number().min(0).max(2).default(0),
    stop: z.array(z.string()).optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    stream: z.boolean().default(true),
  })
  .strict()

export function CompletionRoutes() {
  return new Hono()
    .post("/", async (c) => {
      const body = CompletionInput.parse(await c.req.json())
      const provider = await CompletionRegistry.resolve(body.provider)

      log.info("completion", {
        provider: provider.id,
        language: body.language,
      })

      const completionInput = {
        prefix: body.prefix,
        suffix: body.suffix,
        language: body.language,
        filepath: body.filepath,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        stop: body.stop,
        model: body.model,
      }

      if (body.stream) {
        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())

          try {
            for await (const chunk of provider.complete({
              ...completionInput,
              abort: ac.signal,
            })) {
              await sseStream.writeSSE({
                data: JSON.stringify({ type: "text_delta", text: chunk }),
              })
            }
            await sseStream.writeSSE({
              data: JSON.stringify({ type: "done" }),
            })
          } catch (err) {
            if (ac.signal.aborted) return
            const message =
              err instanceof Error ? err.message : String(err)
            log.error("completion-error", { error: message })
            await sseStream.writeSSE({
              data: JSON.stringify({ type: "error", error: message }),
            })
          }
        })
      }

      // Non-streaming: buffer full completion
      let result = ""
      try {
        for await (const chunk of provider.complete(completionInput)) {
          result += chunk
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, { status: 502 })
      }

      return c.json({ completion: result })
    })
    .get("/providers", async (c) => {
      const providers = await CompletionRegistry.list()
      return c.json({ providers })
    })
}
