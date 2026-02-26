/**
 * Tests for CLI binary detection.
 *
 * Verifies that:
 * 1. ProviderAuth.isAvailable() correctly detects claude/codex on PATH
 * 2. Provider.list() returns the right provider set based on what's installed
 * 3. The /provider server route returns the correct connected/all shape
 *    (this is what sync.tsx reads into store.provider_next to control the UI)
 *
 * The "no CLIs" scenario uses Bun.which({ PATH: "/nonexistent" }) via the
 * envPath parameter added to ProviderAuth.isAvailable(). The "installed"
 * scenario uses the actual environment (tests are skipped when the binary
 * is not present).
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderAuth } from "../../src/provider/auth"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")

// A path string that resolves no binaries (the directory exists, but claude/codex are not in it)
const NO_BIN_PATH = "/nonexistent"

// ─────────────────────────────────────────────────────────────────────────────
// ProviderAuth.isAvailable
// ─────────────────────────────────────────────────────────────────────────────

describe("ProviderAuth.isAvailable", () => {
  test("returns false for claude-code when PATH has no claude binary", async () => {
    expect(await ProviderAuth.isAvailable("claude-code", NO_BIN_PATH)).toBe(false)
  })

  test("returns false for codex when PATH has no codex binary", async () => {
    expect(await ProviderAuth.isAvailable("codex", NO_BIN_PATH)).toBe(false)
  })

  test("returns false for unrecognised provider IDs", async () => {
    expect(await ProviderAuth.isAvailable("openai")).toBe(false)
    expect(await ProviderAuth.isAvailable("anthropic")).toBe(false)
    expect(await ProviderAuth.isAvailable("")).toBe(false)
  })

  test("returns true for claude-code when claude binary is on PATH", async () => {
    if (!Bun.which("claude")) return // skip if not installed

    expect(await ProviderAuth.isAvailable("claude-code")).toBe(true)
  })

  test("returns true for codex when codex binary is on PATH", async () => {
    if (!Bun.which("codex")) return // skip if not installed

    expect(await ProviderAuth.isAvailable("codex")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Provider.list()
// ─────────────────────────────────────────────────────────────────────────────

describe("Provider.list()", () => {
  test("returns empty record when no CLIs are on PATH", async () => {
    // Temporarily replace isAvailable to simulate an empty PATH
    const orig = ProviderAuth.isAvailable
    ;(ProviderAuth as any).isAvailable = async () => false
    try {
      const providers = await Provider.list()
      expect(Object.keys(providers)).toHaveLength(0)
    } finally {
      ;(ProviderAuth as any).isAvailable = orig
    }
  })

  test("returns claude-code entry with correct models when claude is installed", async () => {
    if (!Bun.which("claude")) return // skip

    const providers = await Provider.list()
    const claudeCode = providers["claude-code"]
    expect(claudeCode).toBeDefined()
    expect(claudeCode!.id).toBe("claude-code")
    expect(claudeCode!.name).toBe("Claude Code")

    expect(claudeCode!.models["claude-sonnet-4-6"]).toBeDefined()
    expect(claudeCode!.models["claude-opus-4-6"]).toBeDefined()
    expect(claudeCode!.models["claude-haiku-4-5-20251001"]).toBeDefined()
  })

  test("model entries have required fields", async () => {
    if (!Bun.which("claude")) return // skip

    const providers = await Provider.list()
    const model = providers["claude-code"]?.models["claude-sonnet-4-6"]
    expect(model).toBeDefined()
    expect(model!.id).toBe("claude-sonnet-4-6")
    expect(model!.name).toBe("Claude Sonnet 4.6")
    expect(model!.providerID).toBe("claude-code")
    expect(model!.reasoning).toBe(false)
  })

  test("returns codex entry with correct models when codex is installed", async () => {
    if (!Bun.which("codex")) return // skip

    const providers = await Provider.list()
    const codex = providers["codex"]
    expect(codex).toBeDefined()
    expect(codex!.id).toBe("codex")
    expect(codex!.models["gpt-5-codex"]).toBeDefined()
    expect(codex!.models["o3"]).toBeDefined()
    expect(codex!.models["o4-mini"]).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Provider.sort() — model priority order
// ─────────────────────────────────────────────────────────────────────────────

describe("Provider.sort()", () => {
  const make = (id: string) =>
    ({
      id,
      providerID: "claude-code",
      name: id,
      reasoning: false,
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200_000, output: 8_192 },
    }) satisfies Provider.Model

  test("sonnet sorts before haiku", () => {
    const sorted = Provider.sort([make("claude-haiku-4-5"), make("claude-sonnet-4-6")])
    expect(sorted[0]!.id).toBe("claude-sonnet-4-6")
    expect(sorted[1]!.id).toBe("claude-haiku-4-5")
  })

  test("sonnet sorts before opus", () => {
    const sorted = Provider.sort([make("claude-opus-4-6"), make("claude-sonnet-4-6")])
    expect(sorted[0]!.id).toBe("claude-sonnet-4-6")
  })

  test("full claude-code priority order: sonnet → opus → haiku", () => {
    const sorted = Provider.sort([
      make("claude-haiku-4-5-20251001"),
      make("claude-opus-4-6"),
      make("claude-sonnet-4-6"),
    ])
    expect(sorted.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
    ])
  })

  test("gpt-5-codex sorts before o3 and o4-mini", () => {
    const sorted = Provider.sort([make("o4-mini"), make("o3"), make("gpt-5-codex")])
    expect(sorted[0]!.id).toBe("gpt-5-codex")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /provider — the single provider endpoint sync.tsx bootstraps from
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /provider route", () => {
  test("response has { providers, connected, default }", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const res = await Server.App().request("/provider")
        expect(res.status).toBe(200)

        const body = (await res.json()) as Record<string, unknown>
        expect(body).toHaveProperty("providers")
        expect(body).toHaveProperty("connected")
        expect(body).toHaveProperty("default")
        expect(Array.isArray(body.providers)).toBe(true)
        expect(Array.isArray(body.connected)).toBe(true)
        expect(typeof body.default).toBe("object")
      },
    })
  })

  test("returns all providers but empty connected when no CLIs are installed", async () => {
    const orig = ProviderAuth.isAvailable
    ;(ProviderAuth as any).isAvailable = async () => false
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const res = await Server.App().request("/provider")
          const body = (await res.json()) as { providers: Array<{ id: string }>; connected: string[]; default: Record<string, string> }

          expect(body.connected).toHaveLength(0)
          expect(body.providers).toHaveLength(2)
          expect(body.providers.map((p) => p.id).sort()).toEqual(["claude-code", "codex"])
          expect(body.default).toEqual({})
        },
      })
    } finally {
      ;(ProviderAuth as any).isAvailable = orig
    }
  })

  test("includes claude-code with sonnet as default when claude is installed", async () => {
    if (!Bun.which("claude")) return // skip

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const res = await Server.App().request("/provider")
        const body = (await res.json()) as { providers: Array<{ id: string }>; connected: string[]; default: Record<string, string> }

        expect(body.connected).toContain("claude-code")
        expect(body.providers.some((p) => p.id === "claude-code")).toBe(true)
        expect(body.default["claude-code"]).toBe("claude-sonnet-4-6")
      },
    })
  })
})
