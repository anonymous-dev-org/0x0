import fs from "fs/promises"
import path from "path"
import { Global } from "@/core/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "completion-memory" })

// ─── Types ───────────────────────────────────────────────────────────────────

export type CompletionCategory =
  | "import"
  | "function-body"
  | "type-annotation"
  | "error-handling"
  | "variable"
  | "return"
  | "condition"
  | "argument"
  | "other"

export interface MemoryEntry {
  language: string
  filename?: string
  category: CompletionCategory
  prefix_hash: string
  prefix_snippet: string
  accepted: string
  timestamp: number
}

export interface RejectEntry {
  language: string
  category: CompletionCategory
  prefix_hash: string
  suggested: string
  timestamp: number
}

export interface LearnedRule {
  pattern: string
  category: CompletionCategory
  confidence: number // 0-1, higher = seen more often
  examples: number
  last_seen: number
}

export interface ProjectMemory {
  entries: MemoryEntry[]
  rejects: RejectEntry[]
  rules: LearnedRule[]
}

const DEFAULT_MAX_ENTRIES = 500
const DEFAULT_MAX_REJECTS = 200
const RULE_EXTRACTION_THRESHOLD = 3 // need N similar accepts before creating a rule

// ─── Storage ─────────────────────────────────────────────────────────────────

function projectDir(projectRoot: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(projectRoot)
  const hash = hasher.digest("hex").slice(0, 12)
  return path.join(Global.Path.data, "projects", hash)
}

function memoryPath(projectRoot: string): string {
  return path.join(projectDir(projectRoot), "memory.json")
}

// Global fallback for when no project_root is given
function globalMemoryPath(): string {
  return path.join(Global.Path.data, "completion-memory.json")
}

function hashPrefix(prefix: string): string {
  const snippet = prefix.slice(-200)
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(snippet)
  return hasher.digest("hex").slice(0, 16)
}

async function loadMemory(projectRoot?: string): Promise<ProjectMemory> {
  const filepath = projectRoot ? memoryPath(projectRoot) : globalMemoryPath()
  try {
    const text = await Bun.file(filepath).text()
    const data = JSON.parse(text)
    return {
      entries: data.entries ?? [],
      rejects: data.rejects ?? [],
      rules: data.rules ?? [],
    }
  } catch {
    return { entries: [], rejects: [], rules: [] }
  }
}

async function saveMemory(memory: ProjectMemory, projectRoot?: string): Promise<void> {
  const filepath = projectRoot ? memoryPath(projectRoot) : globalMemoryPath()
  const dir = path.dirname(filepath)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(filepath, JSON.stringify(memory, null, 2))
}

// ─── Category Detection ──────────────────────────────────────────────────────

export function detectCategory(prefix: string, accepted: string): CompletionCategory {
  const lastLine = prefix.split("\n").at(-1)?.trim() ?? ""
  const prefixTail = prefix.slice(-300)

  if (lastLine.startsWith("import ") || lastLine.startsWith("from ") || accepted.trimStart().startsWith("import ")) return "import"
  if (/(?:throw\s+new|\.catch\(|catch\s*\(|try\s*\{)/.test(prefixTail) || /throw\s+new|\.catch\(/.test(accepted)) return "error-handling"
  // Guard clauses: if (!x) commonly leads to throw/return — treat as error-handling
  if (/if\s*\(\s*![\w.]+\s*\)\s*$/.test(lastLine)) return "error-handling"
  if (/:\s*$/.test(lastLine) || /^[A-Z]/.test(accepted.trim())) {
    if (/:\s*$/.test(lastLine) && /^[A-Z][a-zA-Z.<>[\]|&]+/.test(accepted.trim())) return "type-annotation"
  }
  if (/return\s*$/.test(lastLine) || accepted.trimStart().startsWith("return ")) return "return"
  if (/(?:if|else if|while|for)\s*\(?\s*$/.test(lastLine)) return "condition"
  if (/(?:const|let|var)\s+\w+\s*=\s*$/.test(lastLine)) return "variable"
  if (/\(\s*$/.test(lastLine) || /,\s*$/.test(lastLine)) return "argument"
  if (/(?:function|=>|async)\s/.test(prefixTail.slice(-100))) return "function-body"

  return "other"
}

// ─── Accept / Reject ─────────────────────────────────────────────────────────

export async function acceptCompletion(input: {
  language: string
  filename?: string
  prefix: string
  accepted: string
  project_root?: string
  maxEntries?: number
}): Promise<void> {
  const memory = await loadMemory(input.project_root)
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
  const category = detectCategory(input.prefix, input.accepted)

  const entry: MemoryEntry = {
    language: input.language,
    filename: input.filename,
    category,
    prefix_hash: hashPrefix(input.prefix),
    prefix_snippet: input.prefix.slice(-200),
    accepted: input.accepted,
    timestamp: Date.now(),
  }

  memory.entries.push(entry)

  if (memory.entries.length > maxEntries) {
    memory.entries = memory.entries.slice(-maxEntries)
  }

  // After every accept, try to extract new rules
  extractRules(memory, input.language)

  await saveMemory(memory, input.project_root)
  log.info("accepted", { language: input.language, category, project: !!input.project_root, total: memory.entries.length })
}

export async function rejectCompletion(input: {
  language: string
  prefix: string
  suggested: string
  project_root?: string
}): Promise<void> {
  const memory = await loadMemory(input.project_root)
  const category = detectCategory(input.prefix, input.suggested)

  memory.rejects.push({
    language: input.language,
    category,
    prefix_hash: hashPrefix(input.prefix),
    suggested: input.suggested.slice(0, 200),
    timestamp: Date.now(),
  })

  if (memory.rejects.length > DEFAULT_MAX_REJECTS) {
    memory.rejects = memory.rejects.slice(-DEFAULT_MAX_REJECTS)
  }

  await saveMemory(memory, input.project_root)
  log.info("rejected", { language: input.language, category, project: !!input.project_root })
}

// ─── Rule Extraction ─────────────────────────────────────────────────────────

function extractRules(memory: ProjectMemory, language: string): void {
  const langEntries = memory.entries.filter(e => e.language === language)
  if (langEntries.length < RULE_EXTRACTION_THRESHOLD) return

  // Group accepted completions by category
  const byCategory = new Map<CompletionCategory, MemoryEntry[]>()
  for (const entry of langEntries) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }

  const newRules: LearnedRule[] = []

  for (const [category, entries] of byCategory) {
    if (entries.length < RULE_EXTRACTION_THRESHOLD) continue

    // Look for repeated patterns in accepted completions
    const patterns = findRepeatedPatterns(entries)
    for (const { pattern, count } of patterns) {
      // Check if this pattern was rejected more than accepted
      const rejectCount = memory.rejects.filter(
        r => r.category === category && r.suggested.includes(extractPatternCore(pattern))
      ).length
      const acceptCount = count

      // Only keep patterns where accepts significantly outweigh rejects
      if (rejectCount >= acceptCount) continue

      const confidence = Math.min(1, acceptCount / (acceptCount + rejectCount + 2))
      newRules.push({
        pattern,
        category,
        confidence,
        examples: acceptCount,
        last_seen: entries.at(-1)?.timestamp ?? Date.now(),
      })
    }
  }

  // Merge new rules with existing, keeping the strongest version
  const ruleMap = new Map<string, LearnedRule>()
  for (const rule of memory.rules) {
    ruleMap.set(rule.pattern, rule)
  }
  for (const rule of newRules) {
    const existing = ruleMap.get(rule.pattern)
    if (!existing || rule.confidence > existing.confidence || rule.examples > existing.examples) {
      ruleMap.set(rule.pattern, rule)
    }
  }

  // Keep top rules, sorted by confidence * examples
  memory.rules = Array.from(ruleMap.values())
    .sort((a, b) => (b.confidence * b.examples) - (a.confidence * a.examples))
    .slice(0, 30)
}

function findRepeatedPatterns(entries: MemoryEntry[]): Array<{ pattern: string; count: number }> {
  const patternCounts = new Map<string, number>()

  for (const entry of entries) {
    const normalized = normalizeCompletion(entry.accepted)
    if (!normalized || normalized.length < 3) continue

    // Extract structural pattern (strip specific identifiers, keep structure)
    const structural = extractStructuralPattern(normalized)
    if (structural) {
      patternCounts.set(structural, (patternCounts.get(structural) ?? 0) + 1)
    }
  }

  return Array.from(patternCounts.entries())
    .filter(([_, count]) => count >= RULE_EXTRACTION_THRESHOLD)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
}

function normalizeCompletion(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function extractStructuralPattern(text: string): string | null {
  // Detect common structural patterns regardless of specific names/values

  // Error handling: throw new XError(...)
  if (/throw\s+new\s+\w+/.test(text)) return "throw new <ErrorType>(<message>)"

  // Null check: if (!x) { throw/return }
  if (/if\s*\(\s*!/.test(text) && /throw|return/.test(text)) return "if (!<var>) { <throw/return> }"

  // Async/await: const x = await fn()
  if (/const\s+\w+\s*=\s*await\s/.test(text)) return "const <var> = await <fn>()"

  // Return early pattern
  if (/^return\s/.test(text)) return "return <expression>"

  // Arrow function assignment
  if (/const\s+\w+\s*=\s*(?:async\s*)?\(/.test(text)) return "const <fn> = (<params>) => <body>"

  // Object destructuring
  if (/const\s*\{/.test(text)) return "const { <fields> } = <source>"

  // try/catch
  if (/try\s*\{/.test(text)) return "try { <body> } catch { <handler> }"

  // Type assertion/cast
  if (/as\s+[A-Z]/.test(text)) return "<expr> as <Type>"

  // Generic function call: x.method(args)
  if (/\.\w+\(/.test(text) && text.length < 80) return "<obj>.<method>(<args>)"

  return null
}

function extractPatternCore(pattern: string): string {
  // Extract the non-placeholder part for matching against rejects
  return pattern.replace(/<\w+>/g, "").replace(/\s+/g, " ").trim()
}

// ─── Query ───────────────────────────────────────────────────────────────────

export async function getRelevantExamples(input: {
  language: string
  prefix: string
  project_root?: string
  limit?: number
}): Promise<MemoryEntry[]> {
  const memory = await loadMemory(input.project_root)
  const prefixHash = hashPrefix(input.prefix)
  const category = detectCategory(input.prefix, "")
  const limit = input.limit ?? 3

  const langEntries = memory.entries.filter(e => e.language === input.language)

  // Score entries: category match + hash match + recency
  const now = Date.now()
  const scored = langEntries.map(entry => {
    let score = 0
    if (entry.prefix_hash === prefixHash) score += 10
    if (entry.category === category) score += 5
    // Recency bonus: recent entries get up to 3 points
    const ageHours = (now - entry.timestamp) / (1000 * 60 * 60)
    score += Math.max(0, 3 - ageHours / 24)
    return { entry, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.entry)
}

export async function getLearnedRules(input: {
  language: string
  prefix: string
  project_root?: string
  limit?: number
}): Promise<LearnedRule[]> {
  const memory = await loadMemory(input.project_root)
  const category = detectCategory(input.prefix, "")
  const limit = input.limit ?? 5

  // Return rules matching this category or high-confidence general rules
  return memory.rules
    .filter(r => r.category === category || r.confidence > 0.7)
    .sort((a, b) => {
      // Prefer category match, then confidence * examples
      const aMatch = a.category === category ? 10 : 0
      const bMatch = b.category === category ? 10 : 0
      return (bMatch + b.confidence * b.examples) - (aMatch + a.confidence * a.examples)
    })
    .slice(0, limit)
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface MemoryStats {
  total_accepts: number
  total_rejects: number
  learned_rules: number
  acceptance_rate: number
  by_language: Record<string, number>
  by_category: Record<string, { accepts: number; rejects: number }>
  top_rules: Array<{ pattern: string; category: string; confidence: number; examples: number }>
}

export async function getStats(projectRoot?: string): Promise<MemoryStats> {
  const memory = await loadMemory(projectRoot)

  const byLanguage: Record<string, number> = {}
  const byCategory: Record<string, { accepts: number; rejects: number }> = {}

  for (const entry of memory.entries) {
    byLanguage[entry.language] = (byLanguage[entry.language] ?? 0) + 1
    const cat = byCategory[entry.category] ??= { accepts: 0, rejects: 0 }
    cat.accepts++
  }
  for (const entry of memory.rejects) {
    const cat = byCategory[entry.category] ??= { accepts: 0, rejects: 0 }
    cat.rejects++
  }

  const totalAccepts = memory.entries.length
  const totalRejects = memory.rejects.length
  const total = totalAccepts + totalRejects

  return {
    total_accepts: totalAccepts,
    total_rejects: totalRejects,
    learned_rules: memory.rules.length,
    acceptance_rate: total > 0 ? totalAccepts / total : 0,
    by_language: byLanguage,
    by_category: byCategory,
    top_rules: memory.rules.slice(0, 10).map(r => ({
      pattern: r.pattern,
      category: r.category,
      confidence: Math.round(r.confidence * 100) / 100,
      examples: r.examples,
    })),
  }
}

export async function clearMemory(projectRoot?: string): Promise<void> {
  await saveMemory({ entries: [], rejects: [], rules: [] }, projectRoot)
  log.info("memory cleared", { project: !!projectRoot })
}
