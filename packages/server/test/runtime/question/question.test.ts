import { expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { Question } from "../../../src/runtime/question"
import { tmpdir } from "../../fixture/fixture"

test("register - returns request ID and adds to pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const requestID = await Question.register({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(requestID).toStartWith("que_")
      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0]!.id).toBe(requestID)
    },
  })
})

test("register - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      await Question.register({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0]!.questions).toEqual(questions)
    },
  })
})

// reply tests

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const requestID = await Question.register({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reply({
        requestID,
        answers: [["Option 1"]],
      })

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reply({
        requestID: "que_unknown",
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

test("get - returns pending request without removing it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const requestID = await Question.register({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pendingRequest = await Question.get(requestID)
      const pendingAfterLookup = await Question.list()

      expect(pendingRequest?.id).toBe(requestID)
      expect(pendingAfterLookup).toHaveLength(1)
      expect(pendingAfterLookup[0]?.id).toBe(requestID)
    },
  })
})

test("get - returns undefined for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pendingRequest = await Question.get("que_unknown")
      expect(pendingRequest).toBeUndefined()
    },
  })
})

test("register - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const requestID = await Question.register({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0]!.questions.length).toBe(2)

      await Question.reply({
        requestID,
        answers: [["Build"], ["Dev"]],
      })

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

// reject tests

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const requestID = await Question.register({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      await Question.reject(requestID)

      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reject("que_unknown")
      // Should not throw
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.register({
        sessionID: "ses_test1",
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      await Question.register({
        sessionID: "ses_test2",
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(2)
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})

// rejectBySession tests

test("rejectBySession - rejects all pending questions for a session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.register({
        sessionID: "ses_target",
        questions: [
          {
            question: "Q1?",
            header: "Q1",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      await Question.register({
        sessionID: "ses_target",
        questions: [
          {
            question: "Q2?",
            header: "Q2",
            options: [
              { label: "C", description: "C" },
              { label: "D", description: "D" },
            ],
          },
        ],
      })

      // Different session — should NOT be rejected
      await Question.register({
        sessionID: "ses_other",
        questions: [
          {
            question: "Q3?",
            header: "Q3",
            options: [
              { label: "E", description: "E" },
              { label: "F", description: "F" },
            ],
          },
        ],
      })

      const pendingBefore = await Question.list()
      expect(pendingBefore.length).toBe(3)

      await Question.rejectBySession("ses_target")

      // Other session question should still be pending
      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(1)
      expect(pendingAfter[0]!.sessionID).toBe("ses_other")

      // Clean up
      await Question.reject(pendingAfter[0]!.id)
    },
  })
})

test("rejectBySession - does nothing when no pending questions for session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Should not throw even with no pending questions
      await Question.rejectBySession("ses_nonexistent")
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})

// listBySession tests

test("listBySession - returns only questions for the given session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.register({
        sessionID: "ses_a",
        questions: [
          {
            question: "Q1",
            header: "Q1",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })
      await Question.register({
        sessionID: "ses_b",
        questions: [
          {
            question: "Q2",
            header: "Q2",
            options: [
              { label: "C", description: "C" },
              { label: "D", description: "D" },
            ],
          },
        ],
      })

      const sessionA = await Question.listBySession("ses_a")
      expect(sessionA.length).toBe(1)
      expect(sessionA[0]!.questions[0]!.question).toBe("Q1")

      const sessionB = await Question.listBySession("ses_b")
      expect(sessionB.length).toBe(1)

      const sessionC = await Question.listBySession("ses_c")
      expect(sessionC.length).toBe(0)

      // Cleanup
      await Question.rejectBySession("ses_a")
      await Question.rejectBySession("ses_b")
    },
  })
})

// ask() blocking behavior tests

test("ask - blocks until reply resolves the promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
        },
      ]

      let resolved = false
      const askPromise = Question.ask({
        sessionID: "ses_blocking",
        questions,
      }).then(answers => {
        resolved = true
        return answers
      })

      // Promise should not resolve immediately
      await Bun.sleep(10)
      expect(resolved).toBe(false)

      // Find the pending question and reply
      const pending = await Question.listBySession("ses_blocking")
      expect(pending.length).toBe(1)

      await Question.reply({
        requestID: pending[0]!.id,
        answers: [["A"]],
      })

      const result = await askPromise
      expect(resolved).toBe(true)
      expect(result).toEqual([["A"]])
    },
  })
})

test("ask - rejects when rejected", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_reject_ask",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "X", description: "X" },
              { label: "Y", description: "Y" },
            ],
          },
        ],
      })

      const pending = await Question.listBySession("ses_reject_ask")
      await Question.reject(pending[0]!.id)

      expect(askPromise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

// reply outcome tests

test("reply - outcome contains request and answers when ask() is awaiting", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_outcome_ask",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      const pending = await Question.listBySession("ses_outcome_ask")
      const outcome = await Question.reply({
        requestID: pending[0]!.id,
        answers: [["A"]],
      })

      expect(outcome).toBeDefined()
      expect(outcome!.status).toBe("answered")
      if (outcome!.status === "answered") {
        expect(outcome!.answers).toEqual([["A"]])
      }
      expect(outcome!.request.sessionID).toBe("ses_outcome_ask")

      // Consume the ask promise to avoid unhandled rejection
      await askPromise
    },
  })
})

// detachBySession tests

test("detachBySession - settles ask() promise with DetachedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_detach",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      await Question.detachBySession("ses_detach")

      expect(askPromise).rejects.toBeInstanceOf(Question.DetachedError)

      // Clean up entry left in store
      await Question.rejectBySession("ses_detach")
    },
  })
})

test("detachBySession - keeps entries in pending store", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_detach_keep",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      await Question.detachBySession("ses_detach_keep")
      // Consume the rejection to avoid unhandled promise
      await askPromise.catch(() => {})

      const pending = await Question.listBySession("ses_detach_keep")
      expect(pending.length).toBe(1)

      // Clean up
      await Question.rejectBySession("ses_detach_keep")
    },
  })
})

test("detachBySession - reply after detach removes entry and returns outcome", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_detach_reply",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      await Question.detachBySession("ses_detach_reply")
      await askPromise.catch(() => {})

      const pending = await Question.listBySession("ses_detach_reply")
      const outcome = await Question.reply({
        requestID: pending[0]!.id,
        answers: [["A"]],
      })

      expect(outcome).toBeDefined()
      expect(outcome!.status).toBe("answered")
      if (outcome!.status === "answered") {
        expect(outcome!.answers).toEqual([["A"]])
      }

      const afterReply = await Question.listBySession("ses_detach_reply")
      expect(afterReply.length).toBe(0)
    },
  })
})

test("detachBySession - does not affect other sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askTarget = Question.ask({
        sessionID: "ses_detach_target",
        questions: [
          {
            question: "Q1?",
            header: "Q1",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      const askOther = Question.ask({
        sessionID: "ses_detach_other",
        questions: [
          {
            question: "Q2?",
            header: "Q2",
            options: [
              { label: "C", description: "C" },
              { label: "D", description: "D" },
            ],
          },
        ],
      })

      await Question.detachBySession("ses_detach_target")
      await askTarget.catch(() => {})

      // Other session should still have a live pending entry with resolve/reject
      const otherPending = await Question.listBySession("ses_detach_other")
      expect(otherPending.length).toBe(1)

      // Replying to the other session should still resolve its ask() promise
      await Question.reply({
        requestID: otherPending[0]!.id,
        answers: [["C"]],
      })
      const result = await askOther
      expect(result).toEqual([["C"]])

      // Clean up detached target
      await Question.rejectBySession("ses_detach_target")
    },
  })
})

test("detachBySession - does nothing when no pending questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.detachBySession("ses_nonexistent")
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})

test("reply - outcome contains request when no awaiter (register)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const requestID = await Question.register({
        sessionID: "ses_outcome_register",
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: [
              { label: "A", description: "A" },
              { label: "B", description: "B" },
            ],
          },
        ],
      })

      const outcome = await Question.reply({
        requestID,
        answers: [["B"]],
      })

      expect(outcome).toBeDefined()
      expect(outcome!.status).toBe("answered")
      if (outcome!.status === "answered") {
        expect(outcome!.answers).toEqual([["B"]])
      }
      expect(outcome!.request.sessionID).toBe("ses_outcome_register")
    },
  })
})
