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
    await Question.register({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output:
        "Question has been registered and will be shown to the user. Your turn is now ending — the user's answer will be provided in the next message.",
      metadata: {} as { answers?: Question.Answer[] },
    }
  },
})
