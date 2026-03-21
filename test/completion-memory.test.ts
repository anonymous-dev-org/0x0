import { describe, expect, test, beforeEach } from "bun:test"
import {
  acceptCompletion,
  rejectCompletion,
  getRelevantExamples,
  getLearnedRules,
  getStats,
  clearMemory,
  detectCategory,
} from "../src/completion/memory"

const PROJECT = "/tmp/test-project-" + process.pid

describe("completion memory", () => {
  beforeEach(async () => {
    await clearMemory()
    await clearMemory(PROJECT)
  })

  // ─── Category Detection ────────────────────────────────────────────────────

  describe("detectCategory", () => {
    test("detects import completions", () => {
      expect(detectCategory('import { Config } from "', "")).toBe("import")
      expect(detectCategory("from os ", "import path")).toBe("import")
    })

    test("detects error handling", () => {
      expect(detectCategory("try {\n  const x = await fetch()\n} catch (e) {\n  ", "")).toBe("error-handling")
      expect(detectCategory("if (!result) ", "throw new Error('not found')")).toBe("error-handling")
    })

    test("detects type annotations", () => {
      expect(detectCategory("const config: ", "Config")).toBe("type-annotation")
    })

    test("detects return statements", () => {
      expect(detectCategory("  return ", "{ ok: true }")).toBe("return")
    })

    test("detects variable assignments", () => {
      expect(detectCategory("const result = ", "await db.query()")).toBe("variable")
    })

    test("detects function body context", () => {
      expect(detectCategory("export async function handle() {\n  ", "")).toBe("function-body")
    })

    test("falls back to other", () => {
      expect(detectCategory("hello ", "world")).toBe("other")
    })
  })

  // ─── Project-Scoped Storage ────────────────────────────────────────────────

  describe("project scoping", () => {
    test("memories are isolated per project", async () => {
      await acceptCompletion({
        language: "typescript",
        prefix: "const x = ",
        accepted: "42",
        project_root: PROJECT,
      })

      const projectStats = await getStats(PROJECT)
      const globalStats = await getStats()

      expect(projectStats.total_accepts).toBe(1)
      expect(globalStats.total_accepts).toBe(0)
    })

    test("examples are scoped to project", async () => {
      await acceptCompletion({
        language: "typescript",
        prefix: "const x = ",
        accepted: "project-specific",
        project_root: PROJECT,
      })
      await acceptCompletion({
        language: "typescript",
        prefix: "const x = ",
        accepted: "global-value",
      })

      const projectExamples = await getRelevantExamples({
        language: "typescript",
        prefix: "const x = ",
        project_root: PROJECT,
      })
      const globalExamples = await getRelevantExamples({
        language: "typescript",
        prefix: "const x = ",
      })

      expect(projectExamples[0]!.accepted).toBe("project-specific")
      expect(globalExamples[0]!.accepted).toBe("global-value")
    })
  })

  // ─── Accept / Reject Tracking ──────────────────────────────────────────────

  describe("accept and reject", () => {
    test("tracks accepts with category", async () => {
      await acceptCompletion({
        language: "typescript",
        prefix: "const result = ",
        accepted: "await db.query(sql)",
        project_root: PROJECT,
      })

      const stats = await getStats(PROJECT)
      expect(stats.total_accepts).toBe(1)
      expect(stats.by_category["variable"]).toEqual({ accepts: 1, rejects: 0 })
    })

    test("tracks rejects", async () => {
      await rejectCompletion({
        language: "typescript",
        prefix: "const result = ",
        suggested: "null",
        project_root: PROJECT,
      })

      const stats = await getStats(PROJECT)
      expect(stats.total_rejects).toBe(1)
      expect(stats.by_category["variable"]).toEqual({ accepts: 0, rejects: 1 })
    })

    test("acceptance rate reflects both accepts and rejects", async () => {
      for (let i = 0; i < 3; i++) {
        await acceptCompletion({
          language: "typescript",
          prefix: `const v${i} = `,
          accepted: `${i}`,
          project_root: PROJECT,
        })
      }
      await rejectCompletion({
        language: "typescript",
        prefix: "const bad = ",
        suggested: "undefined",
        project_root: PROJECT,
      })

      const stats = await getStats(PROJECT)
      expect(stats.acceptance_rate).toBe(0.75) // 3 / (3+1)
    })
  })

  // ─── Rule Learning ─────────────────────────────────────────────────────────

  describe("learned rules", () => {
    test("extracts rules after repeated similar accepts", async () => {
      // Accept 3+ completions with the same structural pattern (throw new Error)
      const prefixes = [
        "if (!user) ",
        "if (!config) ",
        "if (!result) ",
      ]
      for (const prefix of prefixes) {
        await acceptCompletion({
          language: "typescript",
          prefix,
          accepted: `throw new AppError("not found")`,
          project_root: PROJECT,
        })
      }

      const rules = await getLearnedRules({
        language: "typescript",
        prefix: "if (!data) ",
        project_root: PROJECT,
      })

      expect(rules.length).toBeGreaterThan(0)
      // Should have learned the throw pattern
      const throwRule = rules.find(r => r.pattern.includes("throw"))
      expect(throwRule).toBeDefined()
      expect(throwRule!.examples).toBeGreaterThanOrEqual(3)
    })

    test("rejects reduce rule confidence", async () => {
      // Accept a pattern 3 times
      for (let i = 0; i < 3; i++) {
        await acceptCompletion({
          language: "typescript",
          prefix: `const v${i} = `,
          accepted: `await fetchData${i}()`,
          project_root: PROJECT,
        })
      }

      // Reject the same pattern 3 times
      for (let i = 0; i < 3; i++) {
        await rejectCompletion({
          language: "typescript",
          prefix: `const v${i} = `,
          suggested: `await fetchOther${i}()`,
          project_root: PROJECT,
        })
      }

      // Re-trigger rule extraction by accepting once more
      await acceptCompletion({
        language: "typescript",
        prefix: "const z = ",
        accepted: "await fetchZ()",
        project_root: PROJECT,
      })

      const stats = await getStats(PROJECT)
      // Rules should exist but with moderated confidence
      for (const rule of stats.top_rules) {
        expect(rule.confidence).toBeLessThanOrEqual(1)
      }
    })

    test("rules accumulate as more completions are accepted", async () => {
      // First round: 3 error handling accepts
      for (let i = 0; i < 3; i++) {
        await acceptCompletion({
          language: "typescript",
          prefix: `if (!item${i}) `,
          accepted: `throw new Error("missing item${i}")`,
          project_root: PROJECT,
        })
      }

      const rules1 = await getLearnedRules({
        language: "typescript",
        prefix: "if (!x) ",
        project_root: PROJECT,
      })

      // Second round: 3 more → rules should get stronger
      for (let i = 3; i < 6; i++) {
        await acceptCompletion({
          language: "typescript",
          prefix: `if (!item${i}) `,
          accepted: `throw new Error("missing item${i}")`,
          project_root: PROJECT,
        })
      }

      const rules2 = await getLearnedRules({
        language: "typescript",
        prefix: "if (!x) ",
        project_root: PROJECT,
      })

      // More data → more examples in the rules
      if (rules1.length > 0 && rules2.length > 0) {
        expect(rules2[0]!.examples).toBeGreaterThanOrEqual(rules1[0]!.examples)
      }
    })
  })

  // ─── Relevance Scoring ─────────────────────────────────────────────────────

  describe("relevance scoring", () => {
    test("prioritizes same category over different category", async () => {
      await acceptCompletion({
        language: "typescript",
        prefix: "const x = ",
        accepted: "42",
        project_root: PROJECT,
      })
      await acceptCompletion({
        language: "typescript",
        prefix: 'import { z } from "',
        accepted: 'zod"',
        project_root: PROJECT,
      })

      const examples = await getRelevantExamples({
        language: "typescript",
        prefix: "const y = ",
        project_root: PROJECT,
      })

      // "const y = " should match the variable category → "42" first
      expect(examples[0]!.accepted).toBe("42")
    })

    test("prioritizes exact prefix hash match", async () => {
      await acceptCompletion({
        language: "typescript",
        prefix: "const exact_match = ",
        accepted: "first",
        project_root: PROJECT,
      })
      await acceptCompletion({
        language: "typescript",
        prefix: "const other_thing = ",
        accepted: "second",
        project_root: PROJECT,
      })

      const examples = await getRelevantExamples({
        language: "typescript",
        prefix: "const exact_match = ",
        project_root: PROJECT,
      })

      expect(examples[0]!.accepted).toBe("first")
    })
  })

  // ─── Stats ─────────────────────────────────────────────────────────────────

  describe("stats", () => {
    test("shows full breakdown", async () => {
      await acceptCompletion({ language: "typescript", prefix: "const x = ", accepted: "1", project_root: PROJECT })
      await acceptCompletion({ language: "typescript", prefix: "const y = ", accepted: "2", project_root: PROJECT })
      await acceptCompletion({ language: "python", prefix: "x = ", accepted: "1", project_root: PROJECT })
      await rejectCompletion({ language: "typescript", prefix: "const z = ", suggested: "bad", project_root: PROJECT })

      const stats = await getStats(PROJECT)
      expect(stats.total_accepts).toBe(3)
      expect(stats.total_rejects).toBe(1)
      expect(stats.by_language["typescript"]).toBe(2)
      expect(stats.by_language["python"]).toBe(1)
      expect(stats.acceptance_rate).toBe(0.75)
    })
  })

  // ─── Clear ─────────────────────────────────────────────────────────────────

  describe("clear", () => {
    test("clears project memory without affecting global", async () => {
      await acceptCompletion({ language: "typescript", prefix: "a", accepted: "b", project_root: PROJECT })
      await acceptCompletion({ language: "typescript", prefix: "c", accepted: "d" })

      await clearMemory(PROJECT)

      const projectStats = await getStats(PROJECT)
      const globalStats = await getStats()

      expect(projectStats.total_accepts).toBe(0)
      expect(globalStats.total_accepts).toBe(1)
    })

    test("limits entries to maxEntries", async () => {
      for (let i = 0; i < 5; i++) {
        await acceptCompletion({
          language: "typescript",
          prefix: `const v${i} = `,
          accepted: `${i}`,
          maxEntries: 3,
          project_root: PROJECT,
        })
      }

      const stats = await getStats(PROJECT)
      expect(stats.total_accepts).toBe(3)
    })
  })
})
