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

  export type Outcome =
    | {
        status: "answered"
        request: Request
        answers: Answer[]
      }
    | {
        status: "cancelled"
        request: Request
      }

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

  interface PendingEntry {
    request: Request
    resolve?: (answers: Answer[]) => void
    reject?: (error: Error) => void
  }

  const state = Instance.state(async () => {
    const pending: Record<string, PendingEntry> = {}
    return { pending }
  })

  /**
   * Registers a question request and publishes the event.
   * Non-blocking: returns the question ID immediately.
   * @internal Used by tests only — production code should use `ask()`.
   */
  export async function register(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<string> {
    const s = await state()
    const id = Identifier.ascending("question")

    log.info("register", { id, questions: input.questions.length })

    const request: Request = {
      id,
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
    }

    s.pending[id] = { request }
    Bus.publish(Event.Asked, request)

    return id
  }

  /**
   * Registers a question and blocks until the user answers or rejects.
   * Used by all tool executions (question tool, handoff modal).
   */
  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<Answer[]> {
    const s = await state()
    const id = Identifier.ascending("question")

    log.info("ask", { id, questions: input.questions.length })

    const request: Request = {
      id,
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
    }

    const { promise, resolve, reject } = Promise.withResolvers<Answer[]>()

    s.pending[id] = { request, resolve, reject }
    Bus.publish(Event.Asked, request)

    return promise
  }

  /**
   * Returns all pending question requests for a given session.
   */
  export async function listBySession(sessionID: string): Promise<Request[]> {
    const s = await state()
    return Object.values(s.pending)
      .filter(entry => entry.request.sessionID === sessionID)
      .map(entry => entry.request)
  }

  export async function get(requestID: string): Promise<Request | undefined> {
    const s = await state()
    return s.pending[requestID]?.request
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<Outcome | undefined> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.request.sessionID,
      requestID: existing.request.id,
      answers: input.answers,
    })

    if (existing.resolve) {
      existing.resolve(input.answers)
    }

    return {
      status: "answered",
      request: existing.request,
      answers: input.answers,
    }
  }

  export async function reject(requestID: string): Promise<Outcome | undefined> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.request.sessionID,
      requestID: existing.request.id,
    })

    if (existing.reject) {
      existing.reject(new RejectedError())
    }

    return {
      status: "cancelled",
      request: existing.request,
    }
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  /** Settles promises without removing entries or publishing events.
   *  Used when the session loop exits normally — the ask() awaiters are
   *  orphaned, but the question stays in the pending store so the user
   *  can still answer via the HTTP route (triggering resumeWithQuestionAnswer). */
  export class DetachedError extends Error {
    constructor() {
      super("The session loop ended while this question was pending")
    }
  }

  /** Settles all pending promises for a session (prevents handler leaks)
   *  but keeps entries in the store and does NOT publish question.rejected.
   *  The user can still answer later — the question route's resume path
   *  will restart the session. */
  export async function detachBySession(sessionID: string): Promise<void> {
    const s = await state()
    for (const entry of Object.values(s.pending)) {
      if (entry.request.sessionID !== sessionID) continue
      log.info("detached from session loop", { requestID: entry.request.id, sessionID })
      if (entry.reject) {
        entry.reject(new DetachedError())
      }
      // Clear the callbacks — the promise is settled, but the entry stays
      // so reply() can still find it and trigger resume.
      entry.resolve = undefined
      entry.reject = undefined
    }
  }

  export async function rejectBySession(sessionID: string): Promise<void> {
    const s = await state()
    for (const [id, entry] of Object.entries(s.pending)) {
      if (entry.request.sessionID !== sessionID) continue
      delete s.pending[id]
      log.info("rejected by session cleanup", { requestID: id, sessionID })
      Bus.publish(Event.Rejected, {
        sessionID: entry.request.sessionID,
        requestID: entry.request.id,
      })
      if (entry.reject) {
        entry.reject(new RejectedError())
      }
    }
  }

  export async function list() {
    return state().then(x => Object.values(x.pending).map(entry => entry.request))
  }
}
