import { test, expect } from "bun:test"
import { Question } from "../../../src/runtime/question"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = Question.ask({
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
      expect(promise).toBeInstanceOf(Promise)
    },
  })
})

test("ask - adds to pending list", async () => {
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

      Question.ask({
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

test("reply - resolves the pending ask with answers", async () => {
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

      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()
      const requestID = pending[0]!.id

      await Question.reply({
        requestID,
        answers: [["Option 1"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Option 1"]])
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Question.ask({
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
        requestID: pending[0]!.id,
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

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
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
      await Question.reject(pending[0]!.id)

      await expect(askPromise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
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

      await Question.reject(pending[0]!.id)
      askPromise.catch(() => {}) // Ignore rejection

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
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

// multiple questions tests

test("ask - handles multiple questions", async () => {
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

      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()

      await Question.reply({
        requestID: pending[0]!.id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Question.ask({
        sessionID: "ses_test1",
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      Question.ask({
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
      const promise1 = Question.ask({
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

      const promise2 = Question.ask({
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
      const promise3 = Question.ask({
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

      // Both target session questions should be rejected
      await expect(promise1).rejects.toBeInstanceOf(Question.RejectedError)
      await expect(promise2).rejects.toBeInstanceOf(Question.RejectedError)

      // Other session question should still be pending
      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(1)
      expect(pendingAfter[0]!.sessionID).toBe("ses_other")

      // Clean up
      await Question.reject(pendingAfter[0]!.id)
      promise3.catch(() => {})
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
