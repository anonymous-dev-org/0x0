import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { claudeStream } from "@/provider/sdk/claude-code"
import { Config } from "@/config/config"

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

function buildAnthropicBody(input: CompletionInput) {
  const language = input.language || "text"
  const filename = input.filename || "untitled"

  const userContent = [
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

  return {
    model: input.model || "claude-haiku-4-5-20251001",
    max_tokens: input.max_tokens || 256,
    temperature: 0,
    stream: true,
    stop_sequences: ["\n\n\n"],
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: userContent }],
  }
}

function buildTextBody(input: TextInput) {
  return {
    model: input.model || "claude-haiku-4-5-20251001",
    max_tokens: input.max_tokens || 4096,
    temperature: 0,
    stream: true,
    ...(input.system ? { system: input.system } : {}),
    messages: [{ role: "user" as const, content: input.prompt }],
  }
}

async function getApiKey(): Promise<string | undefined> {
  // 1. Check config providers for an anthropic provider with apiKey
  try {
    const config = await Config.get()
    const anthropicProvider = config.provider?.["anthropic"]
    if (anthropicProvider?.options?.apiKey) {
      return anthropicProvider.options.apiKey as string
    }
  } catch {
    // Config may not be available during startup
  }

  // 2. Fall back to env var
  return process.env.ANTHROPIC_API_KEY
}

async function streamAnthropicResponse(
  apiKey: string,
  body: Record<string, unknown>,
  stream: { writeSSE: (data: { data: string }) => Promise<void> },
  timeout = 30_000,
) {
  let response: Response
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Connection: "keep-alive",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    log.error("completion.fetch_error", { error: err })
    await stream.writeSSE({
      data: JSON.stringify({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      }),
    })
    return
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error")
    log.error("completion.api_error", { status: response.status, body: errorBody })
    await stream.writeSSE({
      data: JSON.stringify({
        type: "error",
        error: `Anthropic API error (${response.status}): ${errorBody}`,
      }),
    })
    return
  }

  if (!response.body) {
    await stream.writeSSE({
      data: JSON.stringify({ type: "error", error: "No response body" }),
    })
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEvent = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const newlinePos = buffer.indexOf("\n")
        if (newlinePos === -1) break

        const line = buffer.slice(0, newlinePos)
        buffer = buffer.slice(newlinePos + 1)

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim()
          if (currentEvent === "content_block_delta") {
            try {
              const parsed = JSON.parse(jsonStr)
              if (parsed?.delta?.text) {
                await stream.writeSSE({
                  data: JSON.stringify({
                    type: "delta",
                    text: parsed.delta.text,
                  }),
                })
              }
            } catch {
              // skip malformed JSON
            }
          } else if (currentEvent === "error") {
            try {
              const parsed = JSON.parse(jsonStr)
              await stream.writeSSE({
                data: JSON.stringify({
                  type: "error",
                  error: parsed?.error?.message || "API error",
                }),
              })
            } catch {
              // skip
            }
          }
        }
      }
    }
  } catch (err) {
    log.error("completion.stream_error", { error: err })
    await stream.writeSSE({
      data: JSON.stringify({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      }),
    })
  }

  await stream.writeSSE({
    data: JSON.stringify({ type: "done" }),
  })
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
          ...errors(400, 401),
        },
      }),
      validator("json", CompletionInput),
      async (c) => {
        const input = c.req.valid("json")
        const apiKey = await getApiKey()

        if (!apiKey) {
          return c.json(
            { error: "No Anthropic API key configured. Set ANTHROPIC_API_KEY or configure provider.anthropic.options.apiKey in config." },
            401,
          )
        }

        const body = buildAnthropicBody(input)

        log.info("completion.start", {
          model: body.model,
          prefix_len: input.prefix.length,
          suffix_len: input.suffix.length,
        })

        return streamSSE(c, async (stream) => {
          await streamAnthropicResponse(apiKey, body, stream, 10_000)
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
          ...errors(400, 401),
        },
      }),
      validator("json", TextInput),
      async (c) => {
        const input = c.req.valid("json")
        const apiKey = await getApiKey()

        if (!apiKey) {
          return c.json(
            { error: "No Anthropic API key configured. Set ANTHROPIC_API_KEY or configure provider.anthropic.options.apiKey in config." },
            401,
          )
        }

        const body = buildTextBody(input)

        log.info("completion.text.start", {
          model: body.model,
          prompt_len: input.prompt.length,
        })

        return streamSSE(c, async (stream) => {
          await streamAnthropicResponse(apiKey, body, stream, 30_000)
        })
      },
    ),
)
