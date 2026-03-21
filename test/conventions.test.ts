import { describe, expect, test, beforeEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { getConventions, formatConventions, invalidateCache } from "../src/completion/conventions"

describe("conventions", () => {
  let tmpDir: string

  beforeEach(async () => {
    invalidateCache()
    tmpDir = path.join(os.tmpdir(), "conv-test-" + Math.random().toString(36).slice(2))
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  })

  test("detects no-semicolons + double-quotes + 2-space indent", async () => {
    // Write several files with consistent style
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `file${i}.ts`),
        `import { something } from "@/util/thing"
import type { Config } from "./config"

export function handle${i}(input: string) {
  const result = input.trim()
  if (!result) {
    throw new Error("empty input")
  }
  return result
}

export async function fetch${i}(url: string) {
  const response = await fetch(url)
  return response.json()
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.formatting.semicolons).toBe("never")
    expect(conv!.formatting.quotes).toBe("double")
    expect(conv!.formatting.indentation).toBe("2-spaces")
  })

  test("detects import alias prefix @/", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `mod${i}.ts`),
        `import { Log } from "@/util/log"
import { Config } from "@/core/config"
import { NamedError } from "@/util/error"

export function run${i}() {
  const log = Log.create()
  return log
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.imports.aliasPrefix).toBe("@/")
    expect(conv!.imports.typeImports).toBe(false)
  })

  test("detects type imports when used", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `typed${i}.ts`),
        `import type { Model } from "./model"
import type { Config } from "./config"
import { doThing } from "./util"

export function process${i}(m: Model, c: Config) {
  return doThing(m, c)
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.imports.typeImports).toBe(true)
  })

  test("detects camelCase naming", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `naming${i}.ts`),
        `export function getUserById(userId: string) {
  const userName = "test"
  const isActive = true
  return { userName, isActive }
}

export function createNewSession(sessionData: unknown) {
  const sessionId = "abc"
  return sessionId
}

export const defaultConfig = {
  maxRetries: 3,
  timeoutMs: 5000,
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.naming.functions).toBe("camelCase")
    expect(conv!.naming.variables).toBe("camelCase")
  })

  test("detects throw-based error handling with custom error class", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `err${i}.ts`),
        `export class AppError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export function validate(input: string) {
  if (!input) throw new AppError("missing input")
  if (input.length > 100) throw new AppError("too long")
  return input
}

export function parse(data: unknown) {
  if (typeof data !== "string") throw new Error("expected string")
  return JSON.parse(data)
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.errorHandling.style).toBe("throw")
    expect(conv!.errorHandling.customErrorClass).toBe("AppError")
  })

  test("detects namespace and zod patterns", async () => {
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `ns${i}.ts`),
        `import z from "zod"

export namespace Module${i} {
  export const Schema = z.object({
    id: z.string(),
    name: z.string(),
  })
  export type Info = z.infer<typeof Schema>

  export function create(input: Info) {
    return input
  }
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.patterns).toContain("Uses TypeScript namespaces for module organization")
    expect(conv!.patterns).toContain("Uses Zod for schema validation")
  })

  test("detects async/await preference", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `async${i}.ts`),
        `export async function loadData() {
  const res = await fetch("/api")
  const data = await res.json()
  const processed = await transform(data)
  return processed
}

export async function saveData(data: unknown) {
  const result = await db.insert(data)
  await notify(result.id)
  return result
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    expect(conv!.patterns).toContain("Strongly prefers async/await over .then()")
  })

  test("returns null for project with too few files", async () => {
    await fs.writeFile(path.join(tmpDir, "src", "only.ts"), "export const x = 1\n")
    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).toBeNull()
  })

  test("caches conventions across calls", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `c${i}.ts`),
        `export function fn${i}() { return ${i} }\n`,
      )
    }

    const first = await getConventions(tmpDir, "typescript")
    const second = await getConventions(tmpDir, "typescript")
    // Same reference means cached
    expect(first).toBe(second)
  })

  test("invalidateCache clears cache", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `inv${i}.ts`),
        `export function fn${i}() { return ${i} }\n`,
      )
    }

    const first = await getConventions(tmpDir, "typescript")
    invalidateCache(tmpDir)
    const second = await getConventions(tmpDir, "typescript")
    // Different reference after invalidation
    expect(first).not.toBe(second)
  })

  test("formatConventions produces readable output", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `fmt${i}.ts`),
        `import { Log } from "@/util/log"

export async function handle${i}() {
  const result = await doThing()
  return result
}
`,
      )
    }

    const conv = await getConventions(tmpDir, "typescript")
    expect(conv).not.toBeNull()
    const output = formatConventions(conv!)
    expect(output.length).toBeGreaterThan(0)
    // Should contain at least some formatting info
    expect(output).toContain("Formatting:")
  })
})
