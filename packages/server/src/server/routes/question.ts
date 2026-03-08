import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Question } from "@/runtime/question"
import { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const log = Log.create({ service: "question-route" })

export const QuestionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(Question.Request.array()),
              },
            },
          },
        },
      }),
      async c => {
        const questions = await Question.list()
        return c.json(questions)
      }
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: z.string(),
        })
      ),
      validator("json", Question.Reply),
      async c => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")

        log.info("reply: start", { requestID: params.requestID, answers: json.answers })

        // Look up the pending question without removing it yet
        const request = await Question.get(params.requestID)
        if (!request) {
          log.warn("reply: question not found", { requestID: params.requestID })
          return c.json({ error: "Question not found" }, 404)
        }

        log.info("reply: found question", { requestID: params.requestID, sessionID: request.sessionID })

        // Stage the answer as a user message BEFORE committing the reply.
        // If staging fails, the question stays pending and the client keeps the modal open.
        const text = SessionPrompt.questionAnswerTemplate(request.questions, json.answers)
        log.info("reply: staging answer", { sessionID: request.sessionID, textLength: text.length })
        const staged = await SessionPrompt.stageInteractionResponse({ sessionID: request.sessionID, text })
        log.info("reply: staged", { sessionID: request.sessionID, messageID: staged.info.id, role: staged.info.role })

        // Now it's safe to commit: remove from pending and emit question.replied
        await Question.reply({
          requestID: params.requestID,
          answers: json.answers,
        })
        log.info("reply: committed", { requestID: params.requestID })

        // Resume the assistant loop in the background (failures surface via session.error event).
        // stageInteractionResponse always creates a user message with a model, so narrow the type.
        const userInfo = staged.info
        if (userInfo.role !== "user" || !userInfo.model) {
          log.error("reply: unexpected message type from staging", { role: userInfo.role })
          throw new Error("stageInteractionResponse returned unexpected message type")
        }
        log.info("reply: resuming loop", { sessionID: request.sessionID, providerID: userInfo.model.providerID })
        SessionPrompt.resumeInteractionLoopInBackground({
          sessionID: request.sessionID,
          providerID: userInfo.model.providerID,
        })

        log.info("reply: done", { requestID: params.requestID })
        return c.json(true)
      }
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: z.string(),
        })
      ),
      async c => {
        const params = c.req.valid("param")
        const outcome = await Question.reject(params.requestID)
        if (outcome?.status === "cancelled") {
          const text = SessionPrompt.questionCancelTemplate()
          SessionPrompt.resumeAfterInteraction({ sessionID: outcome.request.sessionID, text })
        }
        return c.json(true)
      }
    )
)
