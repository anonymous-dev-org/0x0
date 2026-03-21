import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { errors } from "../error"
import { completionStream as claudeCompletionStream } from "@/provider/sdk/claude-code"
import { completionStream as codexCompletionStream } from "@/provider/sdk/codex"
import type { CompletionEvent } from "@/provider/sdk/claude-code"
import { buildCodeCompletionPrompt, buildSystemPrompt, gatherMemoryContext } from "@/completion/prompt"
import { gatherContext } from "@/completion/context"
import { getConventions, invalidateCache } from "@/completion/conventions"
import { acceptCompletion, rejectCompletion, getStats, clearMemory } from "@/completion/memory"
import { Provider } from "@/provider/provider"

const log = Log.create({ service: "completion" })

const CompletionInput = z.object({
  prefix: z.string().meta({ description: "Code before the cursor" }),
  suffix: z.string().meta({ description: "Code after the cursor" }),
  language: z.string().optional().meta({ description: "Programming language" }),
  filename: z.string().optional().meta({ description: "Absolute file path" }),
  project_root: z.string().optional().meta({ description: "Project root directory for context gathering" }),
  model: z.string().optional().meta({ description: "Model ID (default: claude-haiku-4-5-20251001)" }),
  max_tokens: z.number().int().positive().optional().meta({ description: "Max tokens (default: 256)" }),
  provider: z.enum(["claude", "codex"]).optional().meta({ description: "Provider (default: auto-detect)" }),
})
type CompletionInput = z.infer<typeof CompletionInput>

const TextInput = z.object({
  prompt: z.string().meta({ description: "User prompt" }),
  system: z.string().optional().meta({ description: "System prompt" }),
  model: z.string().optional().meta({ description: "Model ID (default: claude-haiku-4-5-20251001)" }),
  max_tokens: z.number().int().positive().optional().meta({ description: "Max tokens (default: 4096)" }),
  provider: z.enum(["claude", "codex"]).optional().meta({ description: "Provider (default: auto-detect)" }),
})
type TextInput = z.infer<typeof TextInput>

const AcceptInput = z.object({
  language: z.string(),
  filename: z.string().optional(),
  prefix: z.string(),
  accepted: z.string(),
  project_root: z.string().optional(),
})

const RejectInput = z.object({
  language: z.string(),
  prefix: z.string(),
  suggested: z.string(),
  project_root: z.string().optional(),
})

const DEFAULT_MODELS: Record<string, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "o4-mini",
}

async function resolveProvider(requested?: string): Promise<string> {
  if (requested) return requested
  return Provider.defaultProvider()
}

function getCompletionStream(provider: string) {
  if (provider === "codex") return codexCompletionStream
  return claudeCompletionStream
}

const sseResponseSchema = resolver(
  z.object({
    type: z.enum(["delta", "done", "error"]),
    text: z.string().optional(),
    error: z.string().optional(),
  }),
)

export const CompletionRoutes = lazy(() =>
  new Hono()
    .post(
      "/",
      describeRoute({
        summary: "Stream code completion",
        description:
          "Stream an inline code completion. Returns SSE events with text deltas.",
        operationId: "completion.stream",
        responses: {
          200: {
            description: "SSE stream of completion text deltas",
            content: { "text/event-stream": { schema: sseResponseSchema } },
          },
          ...errors(400),
        },
      }),
      validator("json", CompletionInput),
      async (c) => {
        const input = c.req.valid("json")
        const provider = await resolveProvider(input.provider)
        const model = input.model || DEFAULT_MODELS[provider] || "claude-haiku-4-5-20251001"
        const stream = getCompletionStream(provider)
        const language = input.language || "typescript"

        log.info("completion.start", {
          provider,
          model,
          prefix_len: input.prefix.length,
          suffix_len: input.suffix.length,
          has_project_root: !!input.project_root,
        })

        // Gather all context layers in parallel
        const [conventions, context, memoryCtx] = await Promise.all([
          input.project_root
            ? getConventions(input.project_root, language).catch(() => null)
            : null,
          input.project_root && input.filename
            ? gatherContext({
                projectRoot: input.project_root,
                filename: input.filename,
                prefix: input.prefix,
                suffix: input.suffix,
                language,
              }).catch(() => undefined)
            : undefined,
          gatherMemoryContext({
            language,
            prefix: input.prefix,
            project_root: input.project_root,
          }),
        ])

        const systemPrompt = await buildSystemPrompt({
          language: input.language,
          prefix: input.prefix,
          project_root: input.project_root,
          hasProjectContext: !!context,
          hasConventions: !!conventions,
          hasLearnedRules: memoryCtx.rules.length > 0,
        })

        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())
          for await (const event of stream({
            model,
            prompt: buildCodeCompletionPrompt({
              ...input,
              context: context ?? undefined,
              conventions: conventions ?? undefined,
              learnedRules: memoryCtx.rules.length > 0 ? memoryCtx.rules : undefined,
              examples: memoryCtx.examples.length > 0 ? memoryCtx.examples : undefined,
            }),
            systemPrompt,
            stopSequences: ["\n\n\n"],
            abort: ac.signal,
          })) {
            await sseStream.writeSSE({ data: JSON.stringify(event) })
            if (event.type === "done" || event.type === "error") break
          }
        })
      },
    )
    .post(
      "/text",
      describeRoute({
        summary: "Stream text generation",
        description:
          "Stream a general-purpose text generation. Returns SSE events with text deltas.",
        operationId: "completion.text",
        responses: {
          200: {
            description: "SSE stream of generated text deltas",
            content: { "text/event-stream": { schema: sseResponseSchema } },
          },
          ...errors(400),
        },
      }),
      validator("json", TextInput),
      async (c) => {
        const input = c.req.valid("json")
        const provider = await resolveProvider(input.provider)
        const model = input.model || DEFAULT_MODELS[provider] || "claude-haiku-4-5-20251001"
        const stream = getCompletionStream(provider)

        log.info("completion.text.start", {
          provider,
          model,
          prompt_len: input.prompt.length,
        })

        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())
          for await (const event of stream({
            model,
            prompt: input.prompt,
            systemPrompt: input.system,
            abort: ac.signal,
          })) {
            await sseStream.writeSSE({ data: JSON.stringify(event) })
            if (event.type === "done" || event.type === "error") break
          }
        })
      },
    )
    .post(
      "/accept",
      validator("json", AcceptInput),
      async (c) => {
        const input = c.req.valid("json")
        await acceptCompletion(input)
        return c.json({ ok: true })
      },
    )
    .post(
      "/reject",
      validator("json", RejectInput),
      async (c) => {
        const input = c.req.valid("json")
        await rejectCompletion(input)
        return c.json({ ok: true })
      },
    )
    .get(
      "/memory/stats",
      async (c) => {
        const projectRoot = c.req.query("project_root")
        const stats = await getStats(projectRoot || undefined)
        return c.json(stats)
      },
    )
    .delete(
      "/memory",
      async (c) => {
        const projectRoot = c.req.query("project_root")
        await clearMemory(projectRoot || undefined)
        return c.json({ ok: true })
      },
    )
    .post(
      "/conventions",
      validator("json", z.object({
        project_root: z.string(),
        language: z.string().optional(),
      })),
      async (c) => {
        const { project_root, language } = c.req.valid("json")
        const conventions = await getConventions(project_root, language || "typescript")
        return c.json(conventions ?? { error: "Could not analyze project (too few files)" })
      },
    )
    .delete(
      "/conventions",
      async (c) => {
        const projectRoot = c.req.query("project_root")
        invalidateCache(projectRoot || undefined)
        return c.json({ ok: true })
      },
    ),
)
