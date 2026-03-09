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
        const outcome = await Question.reply({
          requestID: params.requestID,
          answers: json.answers,
        })
        // Only resume the session for non-blocking questions.
        // Blocking questions (from the tool bridge) resolve their pending promise directly,
        // so the model turn continues on its own without needing resumeAfterInteraction.
        if (outcome?.status === "answered" && !outcome.blocking) {
          const text = SessionPrompt.questionAnswerTemplate(outcome.request.questions, outcome.answers)
          SessionPrompt.resumeAfterInteraction({ sessionID: outcome.request.sessionID, text })
        }
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
        // Only resume for non-blocking questions (same reason as reply above)
        if (outcome?.status === "cancelled" && !outcome.blocking) {
          const text = SessionPrompt.questionCancelTemplate()
          SessionPrompt.resumeAfterInteraction({ sessionID: outcome.request.sessionID, text })
        }
        return c.json(true)
      }
    )
)
