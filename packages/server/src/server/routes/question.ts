import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Question } from "@/runtime/question"
import { SessionPrompt } from "@/session/prompt"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

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

        // Look up the pending question without removing it yet
        const request = await Question.get(params.requestID)
        if (!request) {
          return c.json({ error: "Question not found" }, 404)
        }

        // Stage the answer as a user message BEFORE committing the reply.
        // If staging fails, the question stays pending and the client keeps the modal open.
        const text = SessionPrompt.questionAnswerTemplate(request.questions, json.answers)
        const staged = await SessionPrompt.stageInteractionResponse({ sessionID: request.sessionID, text })

        // Now it's safe to commit: remove from pending and emit question.replied
        await Question.reply({
          requestID: params.requestID,
          answers: json.answers,
        })

        // Resume the assistant loop in the background (failures surface via session.error event).
        // stageInteractionResponse always creates a user message with a model, so narrow the type.
        const userInfo = staged.info
        if (userInfo.role !== "user" || !userInfo.model) {
          throw new Error("stageInteractionResponse returned unexpected message type")
        }
        SessionPrompt.resumeInteractionLoopInBackground({
          sessionID: request.sessionID,
          providerID: userInfo.model.providerID,
        })

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
