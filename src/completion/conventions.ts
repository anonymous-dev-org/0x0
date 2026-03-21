import fs from "fs/promises"
import path from "path"
import { Log } from "@/util/log"

const log = Log.create({ service: "conventions" })

const SAMPLE_FILE_COUNT = 15
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectConventions {
  /** e.g. "typescript", "python" */
  language: string
  /** Formatting observations */
  formatting: {
    semicolons: "always" | "never" | "mixed"
    quotes: "single" | "double" | "mixed"
    indentation: "tabs" | "2-spaces" | "4-spaces" | "mixed"
    trailingCommas: boolean
  }
  /** Import style */
  imports: {
    /** e.g. "@/", "~/", relative only */
    aliasPrefix: string | null
    /** Whether `import type` is used */
    typeImports: boolean
    /** Whether imports are sorted/grouped */
    groupedImports: boolean
  }
  /** Naming conventions observed */
  naming: {
    functions: "camelCase" | "snake_case" | "mixed"
    variables: "camelCase" | "snake_case" | "mixed"
    types: "PascalCase" | "mixed"
    files: "kebab-case" | "camelCase" | "snake_case" | "mixed"
  }
  /** Error handling patterns */
  errorHandling: {
    style: "throw" | "return-result" | "mixed"
    customErrorClass: string | null
  }
  /** Structural patterns */
  patterns: string[]
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, { conventions: ProjectConventions; timestamp: number }>()

export async function getConventions(projectRoot: string, language: string): Promise<ProjectConventions | null> {
  const key = `${projectRoot}:${language}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.conventions
  }

  try {
    const conventions = await analyzeProject(projectRoot, language)
    if (conventions) {
      cache.set(key, { conventions, timestamp: Date.now() })
    }
    return conventions
  } catch (err) {
    log.warn("convention analysis failed", { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export function invalidateCache(projectRoot?: string) {
  if (projectRoot) {
    for (const key of cache.keys()) {
      if (key.startsWith(projectRoot + ":")) cache.delete(key)
    }
  } else {
    cache.clear()
  }
}

// ─── Analysis ────────────────────────────────────────────────────────────────

async function analyzeProject(projectRoot: string, language: string): Promise<ProjectConventions | null> {
  const ext = extForLanguage(language)
  const files = await sampleFiles(projectRoot, ext)
  if (files.length < 2) return null

  const contents: string[] = []
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf-8")
      contents.push(text)
    } catch {
      continue
    }
  }
  if (contents.length < 2) return null

  log.info("analyzing conventions", { projectRoot, language, files: contents.length })

  return {
    language,
    formatting: analyzeFormatting(contents),
    imports: analyzeImports(contents, language),
    naming: analyzeNaming(contents, files, language),
    errorHandling: analyzeErrorHandling(contents, language),
    patterns: analyzePatterns(contents, language),
  }
}

async function sampleFiles(projectRoot: string, ext: string): Promise<string[]> {
  const srcDir = path.join(projectRoot, "src")
  const searchDirs = [srcDir, projectRoot]
  const result: string[] = []
  const seen = new Set<string>()

  for (const dir of searchDirs) {
    try {
      await fs.stat(dir)
    } catch {
      continue
    }

    const glob = new Bun.Glob(`**/*${ext}`)
    for await (const entry of glob.scan({ cwd: dir, absolute: true })) {
      if (seen.has(entry)) continue
      if (entry.includes("node_modules")) continue
      if (entry.includes("/dist/")) continue
      if (entry.includes("/.")) continue
      if (entry.includes(".test.") || entry.includes(".spec.") || entry.includes("__test")) continue
      if (entry.includes("/gen/") || entry.includes(".gen.")) continue

      seen.add(entry)
      result.push(entry)
      if (result.length >= SAMPLE_FILE_COUNT) break
    }
    if (result.length >= SAMPLE_FILE_COUNT) break
  }

  return result
}

// ─── Formatting Detection ────────────────────────────────────────────────────

function analyzeFormatting(contents: string[]): ProjectConventions["formatting"] {
  let semiCount = 0
  let noSemiCount = 0
  let singleQuote = 0
  let doubleQuote = 0
  let tabIndent = 0
  let twoSpace = 0
  let fourSpace = 0
  let trailingCommaCount = 0
  let noTrailingCommaCount = 0

  for (const content of contents) {
    const lines = content.split("\n")
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue

      // Semicolons: check statement-ending lines
      if (trimmed.match(/[^;{}\s];\s*$/) || trimmed.match(/;\s*$/)) semiCount++
      if (trimmed.match(/[^;{}\s]\s*$/) && !trimmed.endsWith("{") && !trimmed.endsWith(",") && !trimmed.endsWith("(") && !trimmed.endsWith(")") && trimmed.length > 5) noSemiCount++

      // Quotes in import/string lines
      const singleMatches = trimmed.match(/'/g)?.length ?? 0
      const doubleMatches = trimmed.match(/"/g)?.length ?? 0
      if (trimmed.includes("import ") || trimmed.includes("from ")) {
        singleQuote += singleMatches
        doubleQuote += doubleMatches
      }

      // Indentation
      if (line.startsWith("\t")) tabIndent++
      else if (line.startsWith("    ")) fourSpace++
      else if (line.startsWith("  ") && !line.startsWith("   ")) twoSpace++

      // Trailing commas (in object/array literals)
      if (trimmed.match(/,\s*$/)) trailingCommaCount++
      if (trimmed.match(/[^,]\s*[}\]]\s*$/)) noTrailingCommaCount++
    }
  }

  return {
    semicolons: semiCount > noSemiCount * 2 ? "always" : noSemiCount > semiCount * 2 ? "never" : "mixed",
    quotes: singleQuote > doubleQuote * 1.5 ? "single" : doubleQuote > singleQuote * 1.5 ? "double" : "mixed",
    indentation: tabIndent > twoSpace && tabIndent > fourSpace ? "tabs" : twoSpace > fourSpace ? "2-spaces" : fourSpace > twoSpace ? "4-spaces" : "mixed",
    trailingCommas: trailingCommaCount > noTrailingCommaCount,
  }
}

// ─── Import Style Detection ──────────────────────────────────────────────────

function analyzeImports(contents: string[], language: string): ProjectConventions["imports"] {
  let aliasCount = 0
  let aliasPrefix: string | null = null
  let typeImportCount = 0
  let totalImportCount = 0
  let groupedCount = 0

  for (const content of contents) {
    const lines = content.split("\n")
    let lastWasImport = false
    let hadBlankBetweenImports = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("import ") && !trimmed.startsWith("from ")) {
        if (lastWasImport && !trimmed) hadBlankBetweenImports = true
        if (lastWasImport && trimmed && !trimmed.startsWith("import")) lastWasImport = false
        continue
      }

      lastWasImport = true
      totalImportCount++

      if (trimmed.includes("import type ")) typeImportCount++

      // Detect alias prefix
      const aliasMatch = trimmed.match(/from\s+['"](@\/|~\/|#\/|@\w+\/)/)
      if (aliasMatch) {
        aliasCount++
        aliasPrefix = aliasMatch[1] ?? null
      }
    }

    if (hadBlankBetweenImports) groupedCount++
  }

  return {
    aliasPrefix: aliasCount > 2 ? aliasPrefix : null,
    typeImports: typeImportCount > totalImportCount * 0.1,
    groupedImports: groupedCount > contents.length * 0.3,
  }
}

// ─── Naming Detection ────────────────────────────────────────────────────────

function analyzeNaming(contents: string[], files: string[], language: string): ProjectConventions["naming"] {
  let camelFn = 0
  let snakeFn = 0
  let camelVar = 0
  let snakeVar = 0

  for (const content of contents) {
    // Function names
    const fnMatches = content.matchAll(/(?:function|async function|const|let)\s+([a-zA-Z_]\w*)\s*(?:=\s*(?:async\s*)?\(|\()/g)
    for (const m of fnMatches) {
      const name = m[1]!
      if (name.length < 2) continue
      if (name.includes("_")) snakeFn++
      else if (name[0] === name[0]!.toLowerCase()) camelFn++
    }

    // Variable names (const/let at top level)
    const varMatches = content.matchAll(/(?:const|let)\s+([a-zA-Z_]\w*)\s*[=:]/g)
    for (const m of varMatches) {
      const name = m[1]!
      if (name.length < 2 || name === name.toUpperCase()) continue
      if (name.includes("_")) snakeVar++
      else if (name[0] === name[0]!.toLowerCase()) camelVar++
    }
  }

  // File naming
  const basenames = files.map(f => path.basename(f, path.extname(f)))
  let kebab = 0
  let camelFile = 0
  let snakeFile = 0
  for (const b of basenames) {
    if (b.includes("-")) kebab++
    else if (b.includes("_")) snakeFile++
    else if (b[0] === b[0]!.toLowerCase() && b !== b.toLowerCase()) camelFile++
  }

  return {
    functions: camelFn > snakeFn * 2 ? "camelCase" : snakeFn > camelFn * 2 ? "snake_case" : "mixed",
    variables: camelVar > snakeVar * 2 ? "camelCase" : snakeVar > camelVar * 2 ? "snake_case" : "mixed",
    types: "PascalCase", // almost always PascalCase in typed languages
    files: kebab > camelFile && kebab > snakeFile ? "kebab-case" : snakeFile > kebab ? "snake_case" : camelFile > kebab ? "camelCase" : "mixed",
  }
}

// ─── Error Handling Detection ────────────────────────────────────────────────

function analyzeErrorHandling(contents: string[], language: string): ProjectConventions["errorHandling"] {
  let throwCount = 0
  let returnResultCount = 0
  let customErrorClass: string | null = null

  for (const content of contents) {
    // Count throw statements
    const throws = content.match(/\bthrow\s+new\s+/g)?.length ?? 0
    throwCount += throws

    // Count Result/Either return patterns
    const results = content.match(/return\s+(?:Ok|Err|Result\.|Either\.)/g)?.length ?? 0
    returnResultCount += results

    // Detect custom error classes
    if (!customErrorClass) {
      const errorClassMatch = content.match(/class\s+(\w+Error)\s+extends\s+Error/)
      if (errorClassMatch) customErrorClass = errorClassMatch[1] ?? null
      // Also detect NamedError.create pattern
      const namedErrorMatch = content.match(/(\w+)\s*=\s*NamedError\.create/)
      if (namedErrorMatch) customErrorClass = "NamedError"
    }
  }

  return {
    style: throwCount > returnResultCount * 2 ? "throw" : returnResultCount > throwCount * 2 ? "return-result" : "mixed",
    customErrorClass,
  }
}

// ─── Pattern Detection ───────────────────────────────────────────────────────

function analyzePatterns(contents: string[], language: string): string[] {
  const patterns: string[] = []
  let namespaceCount = 0
  let classCount = 0
  let pureFunctionCount = 0
  let asyncGeneratorCount = 0
  let zodCount = 0
  let builderCount = 0

  for (const content of contents) {
    if (content.includes("export namespace ")) namespaceCount++
    if (/export\s+class\s/.test(content)) classCount++
    if (/export\s+(?:async\s+)?function\s/.test(content)) pureFunctionCount++
    if (/async\s+function\s*\*/.test(content) || /async\s*\*/.test(content)) asyncGeneratorCount++
    if (content.includes("z.object(") || content.includes("z.string()")) zodCount++
    if (content.includes(".use(") && content.includes(".route(")) builderCount++
  }

  const total = contents.length
  if (namespaceCount > total * 0.2) patterns.push("Uses TypeScript namespaces for module organization")
  if (classCount > total * 0.3) patterns.push("Prefers class-based architecture")
  if (pureFunctionCount > classCount * 2) patterns.push("Prefers standalone exported functions over classes")
  if (asyncGeneratorCount > 1) patterns.push("Uses async generators for streaming")
  if (zodCount > total * 0.2) patterns.push("Uses Zod for schema validation")
  if (builderCount > 1) patterns.push("Uses builder/chaining patterns (e.g., Hono route chaining)")

  // Detect async/await vs .then()
  let awaitCount = 0
  let thenCount = 0
  for (const content of contents) {
    awaitCount += content.match(/\bawait\s/g)?.length ?? 0
    thenCount += content.match(/\.then\s*\(/g)?.length ?? 0
  }
  if (awaitCount > thenCount * 3) patterns.push("Strongly prefers async/await over .then()")

  // Detect export style
  let namedExport = 0
  let defaultExport = 0
  for (const content of contents) {
    namedExport += content.match(/export\s+(?:const|function|class|interface|type|enum|namespace)\s/g)?.length ?? 0
    defaultExport += content.match(/export\s+default\s/g)?.length ?? 0
  }
  if (namedExport > defaultExport * 3) patterns.push("Uses named exports exclusively (no default exports)")

  return patterns
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatConventions(conv: ProjectConventions): string {
  const lines: string[] = []

  // Formatting
  const fmt: string[] = []
  if (conv.formatting.semicolons !== "mixed") fmt.push(conv.formatting.semicolons === "always" ? "semicolons" : "no semicolons")
  if (conv.formatting.quotes !== "mixed") fmt.push(`${conv.formatting.quotes} quotes`)
  if (conv.formatting.indentation !== "mixed") fmt.push(conv.formatting.indentation)
  if (conv.formatting.trailingCommas) fmt.push("trailing commas")
  if (fmt.length > 0) lines.push(`Formatting: ${fmt.join(", ")}`)

  // Naming
  const naming: string[] = []
  if (conv.naming.functions !== "mixed") naming.push(`functions: ${conv.naming.functions}`)
  if (conv.naming.variables !== "mixed") naming.push(`variables: ${conv.naming.variables}`)
  if (conv.naming.files !== "mixed") naming.push(`files: ${conv.naming.files}`)
  if (naming.length > 0) lines.push(`Naming: ${naming.join(", ")}`)

  // Imports
  const imp: string[] = []
  if (conv.imports.aliasPrefix) imp.push(`path alias "${conv.imports.aliasPrefix}"`)
  if (conv.imports.typeImports) imp.push("`import type` for type-only imports")
  if (conv.imports.groupedImports) imp.push("imports grouped with blank lines")
  if (imp.length > 0) lines.push(`Imports: ${imp.join(", ")}`)

  // Error handling
  if (conv.errorHandling.style !== "mixed") {
    let errLine = `Errors: ${conv.errorHandling.style === "throw" ? "throw exceptions" : "return Result types"}`
    if (conv.errorHandling.customErrorClass) errLine += ` (uses ${conv.errorHandling.customErrorClass})`
    lines.push(errLine)
  }

  // Patterns
  for (const p of conv.patterns) {
    lines.push(`- ${p}`)
  }

  return lines.join("\n")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extForLanguage(language: string): string {
  const map: Record<string, string> = {
    typescript: ".ts",
    typescriptreact: ".tsx",
    javascript: ".js",
    javascriptreact: ".jsx",
    python: ".py",
    go: ".go",
    rust: ".rs",
  }
  return map[language] || ".ts"
}
