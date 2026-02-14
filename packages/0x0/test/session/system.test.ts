import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

describe("session.system", () => {
  test("composes base, agent, and skill prompts in order", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = await SystemPrompt.instructions()
        const composed = await SystemPrompt.compose({
          agent: "AGENT_LAYER",
          skill: "SKILL_LAYER",
        })

        expect(composed[0]).toBe(base)
        expect(composed[1]).toBe("AGENT_LAYER")
        expect(composed[2]).toBe("SKILL_LAYER")
      },
    })
  })

  test("prefers top-level system_prompt over legacy prompt system overrides", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        system_prompt: "TOP_LEVEL_BASE",
        prompt: {
          system: {
            base: "LEGACY_BASE",
            codex_instructions: "LEGACY_CODEX",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await SystemPrompt.instructions()).toBe("TOP_LEVEL_BASE")
      },
    })
  })

  test("dedupes and removes empty layers", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = await SystemPrompt.instructions()
        const parts = await SystemPrompt.compose({ agent: "   ", skill: base })

        expect(parts).toEqual([base])
      },
    })
  })
})
