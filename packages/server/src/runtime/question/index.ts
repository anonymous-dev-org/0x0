import z from "zod"
import { Bus } from "@/core/bus"
import { BusEvent } from "@/core/bus/bus-event"
import { Identifier } from "@/core/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).min(2).describe("Available answer choices (provide 2-4 specific options)"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      })
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      })
    ),
  }

  interface Waiter {
    resolve: (answers: Answer[]) => void
    reject: (e: Error) => void
  }

  interface PendingEntry {
    info: Request
    waiters: Waiter[]
  }

  const state = Instance.state(async () => {
    const pending: Record<string, PendingEntry> = {}
    return { pending }
  })

  /**
   * Fire-and-forget: registers a question request and publishes the event.
   * Returns the request ID so callers can wait for it later via `waitForAnswer()`.
   */
  export async function register(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<string> {
    const s = await state()
    const id = Identifier.ascending("question")

    log.info("register", { id, questions: input.questions.length })

    const info: Request = {
      id,
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
    }

    s.pending[id] = { info, waiters: [] }
    Bus.publish(Event.Asked, info)

    return id
  }

  /**
   * Blocking: waits for the user to answer a specific question request.
   * Resolves with the answers, or rejects with RejectedError if dismissed.
   */
  export async function waitForAnswer(requestID: string): Promise<Answer[]> {
    const s = await state()
    const entry = s.pending[requestID]
    if (!entry) throw new Error(`No pending question for requestID: ${requestID}`)

    return new Promise<Answer[]>((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
    })
  }

  /**
   * Original blocking API: registers and waits in one call.
   * Kept for backward compatibility.
   */
  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<Answer[]> {
    const requestID = await register(input)
    return waitForAnswer(requestID)
  }

  /**
   * Returns all pending question requests for a given session.
   */
  export async function listBySession(sessionID: string): Promise<Request[]> {
    const s = await state()
    return Object.values(s.pending)
      .filter(entry => entry.info.sessionID === sessionID)
      .map(entry => entry.info)
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    for (const waiter of existing.waiters) {
      waiter.resolve(input.answers)
    }
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    const error = new RejectedError()
    for (const waiter of existing.waiters) {
      waiter.reject(error)
    }
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export async function rejectBySession(sessionID: string): Promise<void> {
    const s = await state()
    for (const [id, entry] of Object.entries(s.pending)) {
      if (entry.info.sessionID !== sessionID) continue
      delete s.pending[id]
      log.info("rejected by session cleanup", { requestID: id, sessionID })
      Bus.publish(Event.Rejected, {
        sessionID: entry.info.sessionID,
        requestID: entry.info.id,
      })
      const error = new RejectedError()
      for (const waiter of entry.waiters) {
        waiter.reject(error)
      }
    }
  }

  export async function list() {
    return state().then(x => Object.values(x.pending).map(x => x.info))
  }
}
