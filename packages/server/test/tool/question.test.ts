import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import * as QuestionModule from "../../src/runtime/question"
import { QuestionTool } from "../../src/tool/question"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let registerSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    registerSpy = spyOn(QuestionModule.Question, "register").mockImplementation(async () => {
      return "que_test123"
    })
  })

  afterEach(() => {
    registerSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
    expect(result.output).toContain("Question has been registered")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [
          { label: "Dog", description: "Man's best friend" },
          { label: "Cat", description: "Independent and curious" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain("Question has been registered")
  })
})
