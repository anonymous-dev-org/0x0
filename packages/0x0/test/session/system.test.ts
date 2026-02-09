import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

describe("session.system", () => {
  test("composes base, agent, and model prompts in order", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = { api: { id: "claude-3-5-sonnet-20241022" } } as Provider.Model
        const base = await SystemPrompt.instructions()
        const provider = await SystemPrompt.model(model)
        const composed = await SystemPrompt.compose({ model, agent: "AGENT_LAYER" })

        expect(composed[0]).toBe(base)
        expect(composed[1]).toBe("AGENT_LAYER")
        expect(composed[2]).toBe(provider[0])
      },
    })
  })
})
