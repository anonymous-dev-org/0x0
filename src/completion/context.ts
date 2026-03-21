import fs from "fs/promises"
import path from "path"
import { Log } from "@/util/log"

const log = Log.create({ service: "completion-context" })

// Budget: keep total context under this to avoid blowing up latency
const MAX_CONTEXT_CHARS = 4000
const MAX_SNIPPET_CHARS = 800
const MAX_SIBLING_FILES = 3
const MAX_SYMBOL_RESULTS = 5

export interface ProjectContext {
  /** Snippets from imported/referenced files (signatures, exports) */
  imports: ContextSnippet[]
  /** Patterns from sibling files (same dir, same extension) */
  siblings: ContextSnippet[]
  /** Definitions of symbols referenced near the cursor */
  symbols: ContextSnippet[]
}

export interface ContextSnippet {
  file: string
  content: string
}

/**
 * Gather relevant project context for a completion request.
 * This reads actual files from disk to understand how code is written
 * in this project — imports, patterns, referenced types.
 */
export async function gatherContext(input: {
  projectRoot: string
  filename: string
  prefix: string
  suffix: string
  language: string
}): Promise<ProjectContext> {
  const ctx: ProjectContext = { imports: [], siblings: [], symbols: [] }
  let budget = MAX_CONTEXT_CHARS

  try {
    // 1. Resolve imports — find what the current file depends on
    const importPaths = parseImports(input.prefix, input.language)
    for (const imp of importPaths) {
      if (budget <= 0) break
      const resolved = await resolveImportPath(imp, input.filename, input.projectRoot)
      if (!resolved) continue

      const snippet = await extractExports(resolved, input.language)
      if (!snippet) continue

      const trimmed = snippet.slice(0, Math.min(MAX_SNIPPET_CHARS, budget))
      ctx.imports.push({ file: path.relative(input.projectRoot, resolved), content: trimmed })
      budget -= trimmed.length
    }

    // 2. Sibling files — same directory, same extension → learn patterns
    const siblingSnippets = await findSiblingPatterns(
      input.filename,
      input.projectRoot,
      input.language,
    )
    for (const sib of siblingSnippets) {
      if (budget <= 0) break
      const trimmed = sib.content.slice(0, Math.min(MAX_SNIPPET_CHARS, budget))
      ctx.siblings.push({ file: sib.file, content: trimmed })
      budget -= trimmed.length
    }

    // 3. Symbol definitions — grep for types/interfaces/classes mentioned near cursor
    const symbols = extractNearCursorSymbols(input.prefix, input.language)
    for (const sym of symbols) {
      if (budget <= 0) break
      const def = await findSymbolDefinition(sym, input.projectRoot, input.filename, input.language)
      if (!def) continue

      const trimmed = def.content.slice(0, Math.min(MAX_SNIPPET_CHARS, budget))
      ctx.symbols.push({ file: def.file, content: trimmed })
      budget -= trimmed.length
    }
  } catch (err) {
    log.warn("context gathering failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return ctx
}

// ─── Import Parsing ──────────────────────────────────────────────────────────

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+(?:type\s+)?(?:\{[^}]*\}|[^;'"]*)\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  javascript: [
    /import\s+(?:\{[^}]*\}|[^;'"]*)\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [
    /from\s+([\w.]+)\s+import/g,
    /import\s+([\w.]+)/g,
  ],
  go: [
    /"\s*([\w./]+)\s*"/g,
  ],
  rust: [
    /use\s+([\w:]+)/g,
  ],
}

export function parseImports(prefix: string, language: string): string[] {
  const patterns = IMPORT_PATTERNS[language] || IMPORT_PATTERNS["typescript"] || []
  const results = new Set<string>()

  for (const pattern of patterns) {
    // Reset lastIndex for global regexes
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(prefix)) !== null) {
      const importPath = match[1]
      if (importPath && !importPath.startsWith("node_modules") && !isBuiltinModule(importPath)) {
        results.add(importPath)
      }
    }
  }

  // Only return relative/project imports, not package imports
  return Array.from(results).filter(p => p.startsWith(".") || p.startsWith("@/") || p.startsWith("~/"))
}

function isBuiltinModule(name: string): boolean {
  const builtins = new Set([
    "fs", "path", "os", "util", "http", "https", "crypto", "stream",
    "events", "buffer", "url", "querystring", "child_process", "cluster",
    "fs/promises", "node:fs", "node:path", "node:os",
  ])
  return builtins.has(name)
}

// ─── Import Resolution ───────────────────────────────────────────────────────

async function resolveImportPath(
  importPath: string,
  currentFile: string,
  projectRoot: string,
): Promise<string | null> {
  const currentDir = path.dirname(currentFile)

  // Handle @/ alias → project root + src/
  let basePath: string
  if (importPath.startsWith("@/")) {
    basePath = path.join(projectRoot, "src", importPath.slice(2))
  } else if (importPath.startsWith("~/")) {
    basePath = path.join(projectRoot, importPath.slice(2))
  } else {
    basePath = path.resolve(currentDir, importPath)
  }

  // Try common extensions
  const candidates = [
    basePath,
    basePath + ".ts",
    basePath + ".tsx",
    basePath + ".js",
    basePath + ".jsx",
    basePath + ".py",
    basePath + ".go",
    basePath + ".rs",
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
  ]

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      continue
    }
  }

  return null
}

// ─── Export Extraction ───────────────────────────────────────────────────────

/**
 * Read a file and extract its public API surface — exports, type definitions,
 * function signatures. We don't need the implementation bodies.
 */
async function extractExports(filePath: string, language: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const lines = content.split("\n")
    const relevant: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()

      // TypeScript/JavaScript: export statements, interfaces, types
      if (language === "typescript" || language === "javascript" || language === "typescriptreact" || language === "javascriptreact") {
        if (
          trimmed.startsWith("export ") ||
          trimmed.startsWith("export default ") ||
          trimmed.startsWith("interface ") ||
          trimmed.startsWith("type ") ||
          trimmed.startsWith("enum ") ||
          trimmed.startsWith("class ")
        ) {
          // Grab the signature line and up to 2 more lines for context
          const chunk = lines.slice(i, i + 3).join("\n")
          relevant.push(chunk)
        }
      }

      // Python: class/def at module level
      if (language === "python") {
        if (
          (trimmed.startsWith("def ") || trimmed.startsWith("class ") || trimmed.startsWith("async def ")) &&
          !line.startsWith(" ") && !line.startsWith("\t")
        ) {
          relevant.push(line)
        }
      }

      // Go: exported symbols (capitalized)
      if (language === "go") {
        if (/^(func|type|var|const)\s+[A-Z]/.test(trimmed)) {
          relevant.push(line)
        }
      }

      // Rust: pub items
      if (language === "rust") {
        if (trimmed.startsWith("pub ")) {
          relevant.push(line)
        }
      }
    }

    if (relevant.length === 0) return null
    return relevant.join("\n")
  } catch {
    return null
  }
}

// ─── Sibling Patterns ────────────────────────────────────────────────────────

/**
 * Find files in the same directory with the same extension.
 * Extract their structure (imports + first few function/class definitions)
 * to show the model "how code is written here."
 */
async function findSiblingPatterns(
  filename: string,
  projectRoot: string,
  language: string,
): Promise<ContextSnippet[]> {
  const dir = path.dirname(filename)
  const ext = path.extname(filename)
  const basename = path.basename(filename)
  const results: ContextSnippet[] = []

  try {
    const entries = await fs.readdir(dir)
    const siblings = entries
      .filter(e => e !== basename && e.endsWith(ext) && !e.endsWith(".test" + ext) && !e.endsWith(".spec" + ext))
      .slice(0, MAX_SIBLING_FILES)

    for (const sib of siblings) {
      const sibPath = path.join(dir, sib)
      try {
        const content = await fs.readFile(sibPath, "utf-8")
        // Extract the "shape" of the file: first 30 lines covering imports + first definitions
        const shape = extractFileShape(content, language)
        if (shape) {
          results.push({
            file: path.relative(projectRoot, sibPath),
            content: shape,
          })
        }
      } catch {
        continue
      }
    }
  } catch {
    // Directory might not exist if filename is synthetic
  }

  return results
}

/**
 * Extract the "shape" of a file — its imports and the first few
 * declarations/function signatures. This teaches the model the
 * patterns used in this part of the codebase.
 */
function extractFileShape(content: string, language: string): string | null {
  const lines = content.split("\n")
  const shape: string[] = []
  let pastImports = false
  let definitions = 0
  const maxDefinitions = 4

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) continue

    // Collect imports
    if (!pastImports) {
      if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("from ") ||
        trimmed.startsWith("require(") ||
        trimmed.startsWith("use ") ||
        trimmed.startsWith("package ")
      ) {
        shape.push(line)
        continue
      }
      if (shape.length > 0) {
        pastImports = true
        shape.push("") // blank line separator
      }
    }

    // Collect definitions (function signatures, types, classes)
    if (pastImports && definitions < maxDefinitions) {
      if (
        trimmed.startsWith("export ") ||
        trimmed.startsWith("function ") ||
        trimmed.startsWith("async function ") ||
        trimmed.startsWith("const ") ||
        trimmed.startsWith("class ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("type ") ||
        trimmed.startsWith("enum ") ||
        trimmed.startsWith("def ") ||
        trimmed.startsWith("async def ") ||
        trimmed.startsWith("fn ") ||
        trimmed.startsWith("pub fn ") ||
        trimmed.startsWith("pub struct ") ||
        /^(func|type)\s+[A-Z]/.test(trimmed)
      ) {
        shape.push(line)
        definitions++
      }
    }

    if (definitions >= maxDefinitions) break
  }

  if (shape.length < 2) return null
  return shape.join("\n")
}

// ─── Symbol Resolution ───────────────────────────────────────────────────────

/**
 * Look at the last ~10 lines of the prefix to find type/interface/class names
 * that might need their definitions included for accurate completion.
 */
export function extractNearCursorSymbols(prefix: string, language: string): string[] {
  const lastLines = prefix.split("\n").slice(-10).join("\n")
  const symbols = new Set<string>()

  // Match PascalCase identifiers that look like types (not keywords)
  const keywords = new Set([
    "String", "Number", "Boolean", "Array", "Object", "Promise", "Error",
    "Map", "Set", "Date", "RegExp", "Function", "Record", "Partial",
    "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
    "True", "False", "None", "Self", "Some", "Ok", "Err",
    "Console", "Math", "JSON", "Infinity",
  ])

  // PascalCase identifiers that are likely user-defined types
  const typePattern = /\b([A-Z][a-zA-Z0-9]{2,})\b/g
  let match: RegExpExecArray | null
  while ((match = typePattern.exec(lastLines)) !== null) {
    const sym = match[1]!
    if (!keywords.has(sym) && sym !== sym.toUpperCase()) {
      symbols.add(sym)
    }
  }

  // Also look for explicit type annotations: `: TypeName`, `<TypeName>`, `as TypeName`
  const annotationPattern = /(?::\s*|<|as\s+)([A-Z][a-zA-Z0-9.]+)/g
  while ((match = annotationPattern.exec(lastLines)) !== null) {
    const sym = match[1]!.split(".")[0]!
    if (!keywords.has(sym)) {
      symbols.add(sym)
    }
  }

  return Array.from(symbols).slice(0, MAX_SYMBOL_RESULTS)
}

/**
 * Search the project for a symbol definition.
 * Uses simple file scanning (no LSP needed).
 */
async function findSymbolDefinition(
  symbol: string,
  projectRoot: string,
  currentFile: string,
  language: string,
): Promise<ContextSnippet | null> {
  // Build patterns to search for
  const patterns = [
    `interface ${symbol}`,
    `type ${symbol}`,
    `class ${symbol}`,
    `enum ${symbol}`,
    `export interface ${symbol}`,
    `export type ${symbol}`,
    `export class ${symbol}`,
    `export enum ${symbol}`,
    `export namespace ${symbol}`,
  ]

  // Search in common source directories
  const searchDirs = [
    path.join(projectRoot, "src"),
    projectRoot,
  ]

  const ext = extForLanguage(language)

  for (const searchDir of searchDirs) {
    try {
      await fs.stat(searchDir)
    } catch {
      continue
    }

    const result = await searchFilesForPattern(searchDir, patterns, ext, currentFile, symbol)
    if (result) {
      return {
        file: path.relative(projectRoot, result.file),
        content: result.content,
      }
    }
  }

  return null
}

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

async function searchFilesForPattern(
  dir: string,
  patterns: string[],
  ext: string,
  excludeFile: string,
  symbol: string,
): Promise<{ file: string; content: string } | null> {
  try {
    const glob = new Bun.Glob(`**/*${ext}`)
    for await (const entry of glob.scan({ cwd: dir, absolute: true })) {
      if (entry === excludeFile) continue
      if (entry.includes("node_modules")) continue
      if (entry.includes(".test.") || entry.includes(".spec.")) continue

      try {
        const content = await fs.readFile(entry, "utf-8")
        for (const pattern of patterns) {
          const idx = content.indexOf(pattern)
          if (idx === -1) continue

          // Found it — extract the definition block (up to 15 lines)
          const before = content.slice(0, idx)
          const lineStart = before.lastIndexOf("\n") + 1
          const afterDef = content.slice(lineStart)
          const defLines = afterDef.split("\n").slice(0, 15)

          // Try to find the closing brace to get the full definition
          let braceDepth = 0
          const result: string[] = []
          for (const line of defLines) {
            result.push(line)
            for (const ch of line) {
              if (ch === "{") braceDepth++
              if (ch === "}") braceDepth--
            }
            if (braceDepth <= 0 && result.length > 1) break
          }

          return { file: entry, content: result.join("\n") }
        }
      } catch {
        continue
      }
    }
  } catch {
    // glob scan failed
  }

  return null
}

// ─── Context Formatting ──────────────────────────────────────────────────────

/**
 * Format gathered context into a string block for injection into the prompt.
 */
export function formatContext(ctx: ProjectContext): string {
  if (ctx.imports.length === 0 && ctx.siblings.length === 0 && ctx.symbols.length === 0) {
    return ""
  }

  const sections: string[] = []

  if (ctx.imports.length > 0) {
    sections.push("<imported_apis>")
    for (const imp of ctx.imports) {
      sections.push(`// ${imp.file}`)
      sections.push(imp.content)
    }
    sections.push("</imported_apis>")
  }

  if (ctx.symbols.length > 0) {
    sections.push("<referenced_types>")
    for (const sym of ctx.symbols) {
      sections.push(`// ${sym.file}`)
      sections.push(sym.content)
    }
    sections.push("</referenced_types>")
  }

  if (ctx.siblings.length > 0) {
    sections.push("<sibling_file_patterns>")
    for (const sib of ctx.siblings) {
      sections.push(`// ${sib.file}`)
      sections.push(sib.content)
    }
    sections.push("</sibling_file_patterns>")
  }

  return sections.join("\n")
}
