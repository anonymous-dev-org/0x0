import { describe, expect, test, beforeEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { parseImports, extractNearCursorSymbols, gatherContext, formatContext } from "../src/completion/context"

// ─── Unit tests for import parsing ──────────────────────────────────────────

describe("parseImports", () => {
  test("parses TypeScript ES module imports", () => {
    const prefix = `import { Hono } from "hono"
import { Config } from "@/core/config"
import { Log } from "./util/log"
import type { Model } from "../provider/provider"
`
    const result = parseImports(prefix, "typescript")
    expect(result).toContain("@/core/config")
    expect(result).toContain("./util/log")
    expect(result).toContain("../provider/provider")
    // "hono" is a package import, not project — should be excluded
    expect(result).not.toContain("hono")
  })

  test("parses Python imports", () => {
    const prefix = `from .models import User
from ..config import Settings
import os
`
    const result = parseImports(prefix, "python")
    // Python relative imports start with .
    expect(result).toContain(".models")
    expect(result).toContain("..config")
  })

  test("returns empty for prefix with no imports", () => {
    const result = parseImports("const x = 42\n", "typescript")
    expect(result).toEqual([])
  })

  test("handles @/ alias imports", () => {
    const prefix = `import { Server } from "@/server/server"\n`
    const result = parseImports(prefix, "typescript")
    expect(result).toContain("@/server/server")
  })
})

// ─── Unit tests for symbol extraction ───────────────────────────────────────

describe("extractNearCursorSymbols", () => {
  test("finds PascalCase type references near cursor", () => {
    const prefix = `
function createServer(config: ServerConfig): HttpServer {
  const app = new HonoApp()
  const provider = new ProviderRegistry()
  `
    const symbols = extractNearCursorSymbols(prefix, "typescript")
    expect(symbols).toContain("ServerConfig")
    expect(symbols).toContain("HttpServer")
    expect(symbols).toContain("HonoApp")
    expect(symbols).toContain("ProviderRegistry")
  })

  test("excludes common built-in types", () => {
    const prefix = `
const items: Array<String> = []
const map = new Map<string, Promise<boolean>>()
const err = new Error("fail")
  `
    const symbols = extractNearCursorSymbols(prefix, "typescript")
    expect(symbols).not.toContain("Array")
    expect(symbols).not.toContain("String")
    expect(symbols).not.toContain("Map")
    expect(symbols).not.toContain("Promise")
    expect(symbols).not.toContain("Error")
  })

  test("finds type annotations", () => {
    const prefix = `const cfg: AppConfig = loadConfig()\n`
    const symbols = extractNearCursorSymbols(prefix, "typescript")
    expect(symbols).toContain("AppConfig")
  })

  test("limits results to 5", () => {
    const prefix = `
type A = Foo & Bar & Baz & Qux & Quux & Corge & Grault & Garply
  `
    const symbols = extractNearCursorSymbols(prefix, "typescript")
    expect(symbols.length).toBeLessThanOrEqual(5)
  })
})

// ─── Integration tests with real files ──────────────────────────────────────

describe("gatherContext", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), "ctx-test-" + Math.random().toString(36).slice(2))
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  })

  test("resolves imports and extracts exports", async () => {
    // Create a types file
    await fs.writeFile(
      path.join(tmpDir, "src", "types.ts"),
      `export interface Config {
  port: number
  host: string
}

export type Provider = "claude" | "codex"

export function createConfig(): Config {
  return { port: 4096, host: "localhost" }
}
`,
    )

    // Create the "current" file prefix that imports from types
    const prefix = `import { Config, createConfig } from "./types"

export function startServer(config: Config) {
  `
    const suffix = `
}`

    const ctx = await gatherContext({
      projectRoot: tmpDir,
      filename: path.join(tmpDir, "src", "server.ts"),
      prefix,
      suffix,
      language: "typescript",
    })

    // Should have found the imports
    expect(ctx.imports.length).toBeGreaterThan(0)
    const typesImport = ctx.imports.find(i => i.file.includes("types.ts"))
    expect(typesImport).toBeDefined()
    expect(typesImport!.content).toContain("interface Config")
  })

  test("finds sibling file patterns", async () => {
    // Create two sibling files in same directory
    await fs.writeFile(
      path.join(tmpDir, "src", "user.ts"),
      `import { db } from "./db"

export async function getUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = $1", [id])
}

export async function createUser(name: string) {
  return db.query("INSERT INTO users (name) VALUES ($1)", [name])
}
`,
    )

    await fs.writeFile(
      path.join(tmpDir, "src", "post.ts"),
      `import { db } from "./db"

export async function getPost(id: string) {
  return db.query("SELECT * FROM posts WHERE id = $1", [id])
}
`,
    )

    // Completing in a new sibling file
    const prefix = `import { db } from "./db"

export async function getComment(id: string) {
  `

    const ctx = await gatherContext({
      projectRoot: tmpDir,
      filename: path.join(tmpDir, "src", "comment.ts"),
      prefix,
      suffix: "\n}",
      language: "typescript",
    })

    // Should find sibling patterns
    expect(ctx.siblings.length).toBeGreaterThan(0)
    // At least one sibling should show the db.query pattern
    const hasPattern = ctx.siblings.some(s => s.content.includes("db.query") || s.content.includes("getUser") || s.content.includes("getPost"))
    expect(hasPattern).toBe(true)
  })

  test("finds symbol definitions", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "models.ts"),
      `export interface UserProfile {
  id: string
  name: string
  email: string
  createdAt: Date
}

export interface PostData {
  id: string
  title: string
  body: string
  author: UserProfile
}
`,
    )

    const prefix = `import { UserProfile } from "./models"

function renderProfile(user: UserProfile) {
  `

    const ctx = await gatherContext({
      projectRoot: tmpDir,
      filename: path.join(tmpDir, "src", "render.ts"),
      prefix,
      suffix: "\n}",
      language: "typescript",
    })

    // Should find UserProfile definition
    expect(ctx.symbols.length).toBeGreaterThan(0)
    const userDef = ctx.symbols.find(s => s.content.includes("interface UserProfile"))
    expect(userDef).toBeDefined()
  })

  test("handles missing project_root gracefully", async () => {
    const ctx = await gatherContext({
      projectRoot: "/nonexistent/path",
      filename: "/nonexistent/path/src/test.ts",
      prefix: "const x = ",
      suffix: "",
      language: "typescript",
    })

    // Should return empty context, not throw
    expect(ctx.imports).toEqual([])
    expect(ctx.siblings).toEqual([])
    expect(ctx.symbols).toEqual([])
  })
})

// ─── Context formatting ─────────────────────────────────────────────────────

describe("formatContext", () => {
  test("formats empty context as empty string", () => {
    const result = formatContext({ imports: [], siblings: [], symbols: [] })
    expect(result).toBe("")
  })

  test("formats imports section", () => {
    const result = formatContext({
      imports: [{ file: "src/types.ts", content: "export interface Config { port: number }" }],
      siblings: [],
      symbols: [],
    })
    expect(result).toContain("<imported_apis>")
    expect(result).toContain("src/types.ts")
    expect(result).toContain("interface Config")
    expect(result).toContain("</imported_apis>")
  })

  test("formats all sections", () => {
    const result = formatContext({
      imports: [{ file: "a.ts", content: "export type A = string" }],
      siblings: [{ file: "b.ts", content: "function handleB() {}" }],
      symbols: [{ file: "c.ts", content: "interface MyType { x: number }" }],
    })
    expect(result).toContain("<imported_apis>")
    expect(result).toContain("<sibling_file_patterns>")
    expect(result).toContain("<referenced_types>")
  })
})
