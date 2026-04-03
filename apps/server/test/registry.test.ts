import { describe, it, expect } from "bun:test"
import { ProviderRegistry } from "@/provider/registry"
import { ClaudeProvider } from "@/provider/claude"
import { CodexProvider } from "@/provider/codex"

describe("ProviderRegistry", () => {
  describe("get()", () => {
    it("returns claude provider by id", () => {
      const p = ProviderRegistry.get("claude")
      expect(p).toBeDefined()
      expect(p!.id).toBe("claude")
    })

    it("returns codex provider by id", () => {
      const p = ProviderRegistry.get("codex")
      expect(p).toBeDefined()
      expect(p!.id).toBe("codex")
    })

    it("returns undefined for unknown provider", () => {
      expect(ProviderRegistry.get("gemini")).toBeUndefined()
    })
  })

  describe("all()", () => {
    it("returns all registered providers", () => {
      const all = ProviderRegistry.all()
      expect(all.length).toBeGreaterThanOrEqual(2)
      const ids = all.map((p) => p.id)
      expect(ids).toContain("claude")
      expect(ids).toContain("codex")
    })
  })

  describe("available()", () => {
    it("returns only available providers", async () => {
      const available = await ProviderRegistry.available()
      expect(Array.isArray(available)).toBe(true)
      // Both CLIs are installed per user confirmation
      const ids = available.map((p) => p.id)
      expect(ids).toContain("claude")
      expect(ids).toContain("codex")
    })
  })

  describe("resolve()", () => {
    it("resolves claude by explicit id", async () => {
      const p = await ProviderRegistry.resolve("claude")
      expect(p.id).toBe("claude")
    })

    it("resolves codex by explicit id", async () => {
      const p = await ProviderRegistry.resolve("codex")
      expect(p.id).toBe("codex")
    })

    it("throws for unknown provider id", async () => {
      await expect(ProviderRegistry.resolve("gemini")).rejects.toThrow("Unknown provider: gemini")
    })

    it("auto-detects a provider when no id given", async () => {
      const p = await ProviderRegistry.resolve()
      expect(["claude", "codex"]).toContain(p.id)
    })

    it("prefers claude when both available", async () => {
      // Since both are installed, claude should be preferred
      const p = await ProviderRegistry.resolve()
      expect(p.id).toBe("claude")
    })
  })

  describe("provider metadata", () => {
    it("claude has correct supportedMessageOptions", () => {
      expect(ClaudeProvider.supportedMessageOptions).toContain("prompt")
      expect(ClaudeProvider.supportedMessageOptions).toContain("system_prompt")
      expect(ClaudeProvider.supportedMessageOptions).toContain("permission_mode")
      expect(ClaudeProvider.supportedMessageOptions).toContain("max_turns")
      expect(ClaudeProvider.supportedMessageOptions).toContain("allowed_tools")
      expect(ClaudeProvider.supportedMessageOptions).toContain("disallowed_tools")
      expect(ClaudeProvider.supportedMessageOptions).not.toContain("sandbox")
    })

    it("codex has correct supportedMessageOptions", () => {
      expect(CodexProvider.supportedMessageOptions).toContain("prompt")
      expect(CodexProvider.supportedMessageOptions).toContain("sandbox")
      expect(CodexProvider.supportedMessageOptions).not.toContain("system_prompt")
      expect(CodexProvider.supportedMessageOptions).not.toContain("permission_mode")
    })

    it("claude inputSchema has required prompt", () => {
      expect(ClaudeProvider.inputSchema.required).toContain("prompt")
      expect(ClaudeProvider.inputSchema.properties).toHaveProperty("prompt")
      expect(ClaudeProvider.inputSchema.properties).toHaveProperty("system_prompt")
      expect(ClaudeProvider.inputSchema.properties).toHaveProperty("permission_mode")
    })

    it("codex inputSchema has required prompt", () => {
      expect(CodexProvider.inputSchema.required).toContain("prompt")
      expect(CodexProvider.inputSchema.properties).toHaveProperty("prompt")
      expect(CodexProvider.inputSchema.properties).toHaveProperty("sandbox")
    })

    it("inputSchema disallows additional properties", () => {
      expect(ClaudeProvider.inputSchema.additionalProperties).toBe(false)
      expect(CodexProvider.inputSchema.additionalProperties).toBe(false)
    })
  })
})
