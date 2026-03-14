import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Question } from "@/runtime/question"
import { SessionPrompt } from "../../session/prompt"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { errors } from "../error"

const log = Log.create({ service: "question.route" })

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
        // If the session loop is idle, the original ask() awaiter is gone —
        // resume the session with the user's answer as a synthetic message.
        if (outcome && !SessionPrompt.isBusy(outcome.request.sessionID)) {
          SessionPrompt.resumeWithQuestionAnswer({
            sessionID: outcome.request.sessionID,
            request: outcome.request,
            answers: json.answers,
          }).catch(e => {
            log.error("failed to resume session after late question answer", {
              sessionID: outcome.request.sessionID,
              requestID: params.requestID,
              error: e,
            })
          })
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
        await Question.reject(params.requestID)
        return c.json(true)
      }
    )
)
