import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./search_remote.txt"
import { abortAfterAny } from "../util/abort"
import { Flag } from "@/flag/flag"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 30 * 1000
const MAX_TIMEOUT = 120 * 1000
const EXA_URL = "https://mcp.exa.ai/mcp"
const EXA_RESULTS = 8

const Schema = z
  .object({
    mode: z.enum(["fetch", "web", "code"]),
    url: z.string().optional().describe("URL to fetch (required for mode=fetch, must start with http:// or https://)"),
    format: z.enum(["text", "markdown", "html"]).optional().describe("Response format for mode=fetch (default: markdown)"),
    timeout: z.number().optional().describe("Timeout in seconds for mode=fetch (max: 120)"),
    query: z.string().optional().describe("Search query (required for mode=web and mode=code)"),
    numResults: z.number().optional().describe("Number of search results for mode=web (default: 8)"),
    livecrawl: z.enum(["fallback", "preferred"]).optional().describe("Live crawl mode for mode=web"),
    type: z.enum(["auto", "fast", "deep"]).optional().describe("Search strategy for mode=web"),
    contextMaxCharacters: z.number().optional().describe("Maximum context length in characters for mode=web"),
    tokensNum: z
      .number()
      .min(1000)
      .max(50000)
      .optional()
      .describe("Context token budget for mode=code (1000-50000, default: 5000)"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "fetch") {
      if (!value.url) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "url is required when mode is \"fetch\"" })
      }
      if (value.query !== undefined) {
        ctx.addIssue({ code: "custom", path: ["query"], message: "query is not valid when mode is \"fetch\"" })
      }
      if (value.numResults !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["numResults"],
          message: "numResults is not valid when mode is \"fetch\"",
        })
      }
      if (value.livecrawl !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["livecrawl"],
          message: "livecrawl is not valid when mode is \"fetch\"",
        })
      }
      if (value.type !== undefined) {
        ctx.addIssue({ code: "custom", path: ["type"], message: "type is not valid when mode is \"fetch\"" })
      }
      if (value.contextMaxCharacters !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["contextMaxCharacters"],
          message: "contextMaxCharacters is not valid when mode is \"fetch\"",
        })
      }
      if (value.tokensNum !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tokensNum"],
          message: "tokensNum is not valid when mode is \"fetch\"",
        })
      }
      return
    }

    if (!value.query) {
      ctx.addIssue({ code: "custom", path: ["query"], message: `query is required when mode is \"${value.mode}\"` })
    }

    if (value.mode === "web") {
      if (value.url !== undefined) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "url is not valid when mode is \"web\"" })
      }
      if (value.format !== undefined) {
        ctx.addIssue({ code: "custom", path: ["format"], message: "format is not valid when mode is \"web\"" })
      }
      if (value.timeout !== undefined) {
        ctx.addIssue({ code: "custom", path: ["timeout"], message: "timeout is not valid when mode is \"web\"" })
      }
      if (value.tokensNum !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tokensNum"],
          message: "tokensNum is not valid when mode is \"web\"",
        })
      }
      return
    }

    if (value.url !== undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url is not valid when mode is \"code\"" })
    }
    if (value.format !== undefined) {
      ctx.addIssue({ code: "custom", path: ["format"], message: "format is not valid when mode is \"code\"" })
    }
    if (value.timeout !== undefined) {
      ctx.addIssue({ code: "custom", path: ["timeout"], message: "timeout is not valid when mode is \"code\"" })
    }
    if (value.numResults !== undefined) {
      ctx.addIssue({ code: "custom", path: ["numResults"], message: "numResults is not valid when mode is \"code\"" })
    }
    if (value.livecrawl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["livecrawl"], message: "livecrawl is not valid when mode is \"code\"" })
    }
    if (value.type !== undefined) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "type is not valid when mode is \"code\"" })
    }
    if (value.contextMaxCharacters !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["contextMaxCharacters"],
        message: "contextMaxCharacters is not valid when mode is \"code\"",
      })
    }
  })

type Metadata = { mode: "fetch" | "web" | "code" }

export const SearchRemoteTool = Tool.define<typeof Schema, Metadata>("search_remote", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{date}}", new Date().toISOString().slice(0, 10))
    },
    parameters: Schema,
    async execute(params, ctx) {
      if (params.mode === "fetch") {
        const url = params.url!
        const format = params.format ?? "markdown"
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error("URL must start with http:// or https://")
        }

        await ctx.ask({
          permission: "search_remote",
          patterns: [url],
          always: ["*"],
          metadata: {
            mode: params.mode,
            url,
            format,
            timeout: params.timeout,
          },
        })

        const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)
        const { signal, clearTimeout } = abortAfterAny(timeout, ctx.abort)

        const headers = {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          Accept: accept(format),
          "Accept-Language": "en-US,en;q=0.9",
        }

        const initial = await fetch(url, { signal, headers })
        const response =
          initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
            ? await fetch(url, { signal, headers: { ...headers, "User-Agent": "zeroxzero" } })
            : initial

        clearTimeout()
        if (!response.ok) throw new Error(`Request failed with status code: ${response.status}`)

        const length = response.headers.get("content-length")
        if (length && Number.parseInt(length) > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)")
        }

        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)")
        }

        const content = new TextDecoder().decode(bytes)
        const contentType = response.headers.get("content-type") || ""
        const title = `${url} (${contentType})`
        if (format === "markdown" && contentType.includes("text/html")) {
          return {
            output: markdown(content),
            title,
            metadata: { mode: params.mode },
          }
        }
        if (format === "text" && contentType.includes("text/html")) {
          return {
            output: await text(content),
            title,
            metadata: { mode: params.mode },
          }
        }
        return {
          output: content,
          title,
          metadata: { mode: params.mode },
        }
      }

      if (ctx.extra?.model?.providerID !== "zeroxzero" && !Flag.ZEROXZERO_ENABLE_EXA) {
        throw new Error(
          "Remote web/code search is unavailable for the current provider unless ZEROXZERO_ENABLE_EXA is set.",
        )
      }

      if (params.mode === "web") {
        const query = params.query!
        await ctx.ask({
          permission: "search_remote",
          patterns: [query],
          always: ["*"],
          metadata: {
            mode: params.mode,
            query,
            numResults: params.numResults,
            livecrawl: params.livecrawl,
            type: params.type,
            contextMaxCharacters: params.contextMaxCharacters,
          },
        })

        const { signal, clearTimeout } = abortAfterAny(25000, ctx.abort)
        try {
          const response = await fetch(EXA_URL, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "web_search_exa",
                arguments: {
                  query,
                  type: params.type || "auto",
                  numResults: params.numResults || EXA_RESULTS,
                  livecrawl: params.livecrawl || "fallback",
                  contextMaxCharacters: params.contextMaxCharacters,
                },
              },
            }),
            signal,
          })

          clearTimeout()
          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Search error (${response.status}): ${errorText}`)
          }

          const out = await response.text()
          const parsed = parseSSE(out)
          if (parsed) {
            return {
              output: parsed,
              title: `Web search: ${query}`,
              metadata: { mode: params.mode },
            }
          }
          return {
            output: "No search results found. Please try a different query.",
            title: `Web search: ${query}`,
            metadata: { mode: params.mode },
          }
        } catch (error) {
          clearTimeout()
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error("Search request timed out")
          }
          throw error
        }
      }

      const query = params.query!
      const tokensNum = params.tokensNum ?? 5000
      await ctx.ask({
        permission: "search_remote",
        patterns: [query],
        always: ["*"],
        metadata: {
          mode: params.mode,
          query,
          tokensNum,
        },
      })

      const { signal, clearTimeout } = abortAfterAny(30000, ctx.abort)
      try {
        const response = await fetch(EXA_URL, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_code_context_exa",
              arguments: {
                query,
                tokensNum,
              },
            },
          }),
          signal,
        })

        clearTimeout()
        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Code search error (${response.status}): ${errorText}`)
        }

        const out = await response.text()
        const parsed = parseSSE(out)
        if (parsed) {
          return {
            output: parsed,
            title: `Code search: ${query}`,
            metadata: { mode: params.mode },
          }
        }
        return {
          output:
            "No code snippets or documentation found. Please try a different query, be more specific about the library or programming concept, or check the spelling of framework names.",
          title: `Code search: ${query}`,
          metadata: { mode: params.mode },
        }
      } catch (error) {
        clearTimeout()
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Code search request timed out")
        }
        throw error
      }
    },
  }
})

function parseSSE(input: string) {
  for (const line of input.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const json = JSON.parse(payload) as {
        result?: {
          content?: {
            text?: string
          }[]
        }
      }
      const text = json.result?.content?.[0]?.text
      if (text) return text
    } catch {
      continue
    }
  }
}

function accept(format: "text" | "markdown" | "html") {
  if (format === "markdown") {
    return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
  }
  if (format === "text") {
    return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
  }
  return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
}

async function text(html: string) {
  let output = ""
  let skip = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skip = true
      },
      text() {},
    })
    .on("*", {
      element(element) {
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skip = false
        }
      },
      text(input) {
        if (!skip) output += input.text
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return output.trim()
}

function markdown(html: string) {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  service.remove(["script", "style", "meta", "link"])
  return service.turndown(html)
}
