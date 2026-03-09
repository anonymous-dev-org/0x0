import z from "zod"
import { Question } from "@/runtime/question"
import DESCRIPTION from "./question.txt"
import { Tool } from "./tool"

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const formatted = params.questions
      .map((q, i) => `Q: ${q.question}\nA: ${(answers[i] ?? []).join(", ")}`)
      .join("\n\n")

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `The user answered your questions:\n\n${formatted}\n\nContinue with the user's answers in mind.`,
      metadata: { answers },
    }
  },
})
