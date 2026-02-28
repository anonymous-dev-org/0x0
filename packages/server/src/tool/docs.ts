import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./docs.txt"
import { Config } from "@/core/config/config"
import { abortAfterAny } from "../util/abort"

const CONTEXT7_BASE = "https://context7.com/api/v2"
const DEFAULT_TIMEOUT = 30_000

const Schema = z
  .object({
    mode: z.enum(["search", "context"]),
    query: z.string().describe("Your question or task (used for relevance ranking)"),
    libraryName: z
      .string()
      .optional()
      .describe('Library name to search for (required for mode="search", e.g., "react", "nextjs")'),
    libraryId: z
      .string()
      .optional()
      .describe('Library identifier from search result (required for mode="context", e.g., "/facebook/react")'),
    tokens: z
      .number()
      .min(1000)
      .max(50000)
      .optional()
      .describe("Max tokens of documentation to retrieve for mode=context (default: 5000)"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "search" && !value.libraryName) {
      ctx.addIssue({ code: "custom", path: ["libraryName"], message: 'libraryName is required when mode is "search"' })
    }
    if (value.mode === "context" && !value.libraryId) {
      ctx.addIssue({ code: "custom", path: ["libraryId"], message: 'libraryId is required when mode is "context"' })
    }
    if (value.mode === "search" && value.libraryId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["libraryId"], message: 'libraryId is not valid when mode is "search"' })
    }
    if (value.mode === "context" && value.libraryName !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["libraryName"],
        message: 'libraryName is not valid when mode is "context"',
      })
    }
  })

type Metadata = { mode: "search" | "context" }

type LibraryResult = {
  id: string
  name: string
  description: string
  totalSnippets: number
  trustScore: number
  versions: string[]
}

export const DocsTool = Tool.define<typeof Schema, Metadata>("docs", async () => {
  const config = await Config.get()
  const apiKey = config.experimental?.context7_api_key!

  return {
    description: DESCRIPTION,
    parameters: Schema,
    async execute(params, ctx) {
      await ctx.ask({
        permission: "docs",
        patterns: [params.query],
        always: ["*"],
        metadata: { mode: params.mode },
      })

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      }

      if (params.mode === "search") {
        const url = new URL(`${CONTEXT7_BASE}/libs/search`)
        url.searchParams.set("query", params.query)
        url.searchParams.set("libraryName", params.libraryName!)

        const { signal, clearTimeout } = abortAfterAny(DEFAULT_TIMEOUT, ctx.abort)
        let response: Response
        try {
          response = await fetch(url, { headers, signal })
          clearTimeout()
        } catch (error) {
          clearTimeout()
          if (error instanceof Error && error.name === "AbortError") throw new Error("Docs search request timed out")
          throw error
        }

        if (!response.ok) throw new Error(`Context7 search failed (${response.status}): ${await response.text()}`)

        const results = (await response.json()) as LibraryResult[]
        if (!results.length) {
          return {
            title: `Library search: ${params.libraryName}`,
            metadata: { mode: params.mode },
            output: "No libraries found. Try a different library name.",
          }
        }

        const lines = results.map(
          (r) =>
            `ID: ${r.id}\nName: ${r.name}\nDescription: ${r.description}\nSnippets: ${r.totalSnippets}, Trust: ${r.trustScore.toFixed(2)}\nVersions: ${r.versions.join(", ")}`,
        )
        return {
          title: `Library search: ${params.libraryName}`,
          metadata: { mode: params.mode },
          output: lines.join("\n\n"),
        }
      }

      const url = new URL(`${CONTEXT7_BASE}/context`)
      url.searchParams.set("query", params.query)
      url.searchParams.set("libraryId", params.libraryId!)
      url.searchParams.set("type", "txt")
      if (params.tokens) url.searchParams.set("tokens", String(params.tokens))

      const { signal, clearTimeout } = abortAfterAny(DEFAULT_TIMEOUT, ctx.abort)
      let response: Response
      try {
        response = await fetch(url, { headers, signal })
        clearTimeout()
      } catch (error) {
        clearTimeout()
        if (error instanceof Error && error.name === "AbortError") throw new Error("Docs context request timed out")
        throw error
      }

      if (!response.ok) throw new Error(`Context7 failed (${response.status}): ${await response.text()}`)

      const output = await response.text()
      return {
        title: `Docs: ${params.libraryId} — ${params.query}`,
        metadata: { mode: params.mode },
        output: output || "No documentation found for this query.",
      }
    },
  }
})
