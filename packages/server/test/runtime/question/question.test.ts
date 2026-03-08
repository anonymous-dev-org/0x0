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
