import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { completionStream } from "@/provider/sdk/claude-code"

const log = Log.create({ service: "completion" })

const CompletionInput = z.object({
  prefix: z.string().meta({ description: "Code before the cursor" }),
  suffix: z.string().meta({ description: "Code after the cursor" }),
  language: z.string().optional().meta({ description: "Programming language" }),
  filename: z.string().optional().meta({ description: "File path" }),
  model: z.string().optional().meta({ description: "Model ID (default: claude-haiku-4-5-20251001)" }),
  max_tokens: z.number().int().positive().optional().meta({ description: "Max tokens (default: 256)" }),
})
type CompletionInput = z.infer<typeof CompletionInput>

const TextInput = z.object({
  prompt: z.string().meta({ description: "User prompt" }),
  system: z.string().optional().meta({ description: "System prompt" }),
  model: z.string().optional().meta({ description: "Model ID (default: claude-haiku-4-5-20251001)" }),
  max_tokens: z.number().int().positive().optional().meta({ description: "Max tokens (default: 4096)" }),
})
type TextInput = z.infer<typeof TextInput>

const SYSTEM_PROMPT =
  "You are a code completion engine. Output ONLY the raw code that should be inserted at the cursor position. No explanations, no markdown fences, no comments about what the code does. Just the code itself."

function buildCodeCompletionPrompt(input: CompletionInput): string {
  const language = input.language || "text"
  const filename = input.filename || "untitled"

  return [
    `<file_info>`,
    `Language: ${language}`,
    `File: ${filename}`,
    `</file_info>`,
    `<code_before_cursor>`,
    input.prefix,
    `</code_before_cursor>`,
    `<code_after_cursor>`,
    input.suffix,
    `</code_after_cursor>`,
  ].join("\n")
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
          "Stream an inline code completion using the Anthropic API. Returns SSE events with text deltas.",
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
        const model = input.model || "claude-haiku-4-5-20251001"

        log.info("completion.start", {
          model,
          prefix_len: input.prefix.length,
          suffix_len: input.suffix.length,
        })

        return streamSSE(c, async (stream) => {
          for await (const event of completionStream({
            model,
            prompt: buildCodeCompletionPrompt(input),
            systemPrompt: SYSTEM_PROMPT,
            stopSequences: ["\n\n\n"],
          })) {
            await stream.writeSSE({ data: JSON.stringify(event) })
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
          "Stream a general-purpose text generation using the Anthropic API. Returns SSE events with text deltas.",
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
        const model = input.model || "claude-haiku-4-5-20251001"

        log.info("completion.text.start", {
          model,
          prompt_len: input.prompt.length,
        })

        return streamSSE(c, async (stream) => {
          for await (const event of completionStream({
            model,
            prompt: input.prompt,
            systemPrompt: input.system,
          })) {
            await stream.writeSSE({ data: JSON.stringify(event) })
            if (event.type === "done" || event.type === "error") break
          }
        })
      },
    ),
)
