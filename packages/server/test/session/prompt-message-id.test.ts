import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/core/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

describe("session.prompt messageID passthrough", () => {
  test("uses client-provided messageID when given", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const clientMessageID = Identifier.ascending("message")

        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "builder",
          messageID: clientMessageID,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        expect(result.info.id).toBe(clientMessageID)
        await Session.remove(session.id)
      },
    })
  })

  test("generates messageID when not provided", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "builder",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        expect(result.info.id).toStartWith("msg_")
        await Session.remove(session.id)
      },
    })
  })
})
