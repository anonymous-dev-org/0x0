import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    reasoning: false,
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }
}

function tokens(input: number, output: number, cacheRead = 0) {
  return { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } }
}

describe("session.compaction.shouldCompact", () => {
  test("returns true when token usage >= 80% of usable context", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // usable = 100_000 - 32_000 = 68_000, 80% = 54_400
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(55_000, 0) })).toBe(true)
  })

  test("returns false when token usage < 80% of usable context", () => {
    const model = createModel({ context: 200_000, output: 32_000 })
    // usable = 168_000, 80% = 134_400
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(100_000, 10_000) })).toBe(false)
  })

  test("includes cache.read in token count", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // usable = 68_000, 80% = 54_400
    // used = 40_000 + 5_000 + 10_000 = 55_000 >= 54_400
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(40_000, 5_000, 10_000) })).toBe(true)
  })

  test("respects input limit when set", () => {
    const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
    // usable = min(400_000 - 128_000, 272_000) = min(272_000, 272_000) = 272_000
    // 80% = 217_600; used = 220_000 >= 217_600
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(218_000, 1_000, 1_000) })).toBe(true)
  })

  test("returns false when within input limit", () => {
    const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
    // usable = 272_000, 80% = 217_600; used = 200_000 + 10_000 + 5_000 = 215_000 < 217_600
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(200_000, 10_000, 5_000) })).toBe(false)
  })

  test("returns false when model context limit is 0", () => {
    const model = createModel({ context: 0, output: 32_000 })
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(100_000, 10_000) })).toBe(false)
  })

  test("exact 80% boundary — just under returns false", () => {
    const model = createModel({ context: 100_000, output: 20_000 })
    // usable = 80_000, 80% = 64_000
    // used = 63_999 < 64_000
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(63_999, 0) })).toBe(false)
  })

  test("exact 80% boundary — at threshold returns true", () => {
    const model = createModel({ context: 100_000, output: 20_000 })
    // usable = 80_000, 80% = 64_000
    expect(SessionCompaction.shouldCompact({ model, tokens: tokens(64_000, 0) })).toBe(true)
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("does not subtract cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles reasoning tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })
})
