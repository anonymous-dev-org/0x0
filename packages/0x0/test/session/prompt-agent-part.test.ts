import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

describe("session.prompt agent mention handling", () => {
  test("does not transform agent parts into task tool instructions", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-5",
          },
          noReply: true,
          parts: [
            { type: "text", text: "hello" },
            { type: "agent", name: "general" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const text = msg.parts
          .filter((part): part is (typeof msg.parts)[number] & { type: "text" } => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).toContain("hello")
        expect(text).not.toContain("call the task tool")
        expect(msg.parts.some((part) => part.type === "agent")).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})
