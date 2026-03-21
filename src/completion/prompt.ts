import type { MemoryEntry, LearnedRule } from "./memory"
import { getRelevantExamples, getLearnedRules } from "./memory"
import type { ProjectContext } from "./context"
import { formatContext } from "./context"
import type { ProjectConventions } from "./conventions"
import { formatConventions } from "./conventions"

export const SYSTEM_PROMPT =
  "You are a code completion engine. Output ONLY the raw code that should be inserted at the cursor position. No explanations, no markdown fences, no comments about what the code does. Just the code itself. Match the style, naming conventions, and patterns of the surrounding code and project."

export function buildCodeCompletionPrompt(input: {
  prefix: string
  suffix: string
  language?: string
  filename?: string
  context?: ProjectContext
  conventions?: ProjectConventions
  learnedRules?: LearnedRule[]
  examples?: MemoryEntry[]
}): string {
  const language = input.language || "text"
  const filename = input.filename || "untitled"

  const parts = [
    `<file_info>`,
    `Language: ${language}`,
    `File: ${filename}`,
    `</file_info>`,
  ]

  // Conventions go first — they set the baseline rules for the whole project
  if (input.conventions) {
    const convBlock = formatConventions(input.conventions)
    if (convBlock) {
      parts.push(`<project_conventions>`)
      parts.push(convBlock)
      parts.push(`</project_conventions>`)
    }
  }

  // Learned rules from accepted/rejected completions
  if (input.learnedRules && input.learnedRules.length > 0) {
    parts.push(`<learned_preferences>`)
    parts.push(formatRules(input.learnedRules))
    parts.push(`</learned_preferences>`)
  }

  // Project context — APIs, types, sibling patterns
  if (input.context) {
    const ctxBlock = formatContext(input.context)
    if (ctxBlock) {
      parts.push(`<project_context>`)
      parts.push(ctxBlock)
      parts.push(`</project_context>`)
    }
  }

  // Past accepted examples as few-shot
  if (input.examples && input.examples.length > 0) {
    parts.push(`<accepted_examples>`)
    parts.push(formatExamples(input.examples))
    parts.push(`</accepted_examples>`)
  }

  parts.push(
    `<code_before_cursor>`,
    input.prefix,
    `</code_before_cursor>`,
    `<code_after_cursor>`,
    input.suffix,
    `</code_after_cursor>`,
  )

  return parts.join("\n")
}

function formatRules(rules: LearnedRule[]): string {
  const lines: string[] = []
  lines.push("The user has established these patterns through repeated use:")
  for (const rule of rules) {
    const pct = Math.round(rule.confidence * 100)
    lines.push(`- [${rule.category}] ${rule.pattern} (${pct}% confidence, ${rule.examples} examples)`)
  }
  return lines.join("\n")
}

function formatExamples(examples: MemoryEntry[]): string {
  const lines: string[] = []
  for (const ex of examples) {
    const snippetEnd = ex.prefix_snippet.slice(-80).replace(/\n/g, "\\n")
    const accepted = ex.accepted.slice(0, 120).replace(/\n/g, "\\n")
    lines.push(`[${ex.category}] ...${snippetEnd} -> ${accepted}`)
  }
  return lines.join("\n")
}

export async function buildSystemPrompt(input: {
  language?: string
  prefix: string
  project_root?: string
  memoryEnabled?: boolean
  hasProjectContext?: boolean
  hasConventions?: boolean
  hasLearnedRules?: boolean
}): Promise<string> {
  let prompt = SYSTEM_PROMPT

  if (input.hasConventions) {
    prompt += "\n\nThe <project_conventions> block describes this project's coding style. Follow these conventions exactly — formatting, naming, imports, error handling, and structural patterns."
  }

  if (input.hasLearnedRules) {
    prompt += "\n\nThe <learned_preferences> block contains patterns the user has repeatedly accepted in this project. Strongly prefer these patterns over alternatives. They represent how the user actually writes code here."
  }

  if (input.hasProjectContext) {
    prompt += "\n\nThe <project_context> block contains APIs, types, and patterns from this project. Use them to produce completions that match the project's conventions."
  }

  return prompt
}

/**
 * Gather all memory-based prompt enrichments for a completion request.
 * Returns examples + learned rules, scoped to the project when available.
 */
export async function gatherMemoryContext(input: {
  language: string
  prefix: string
  project_root?: string
}): Promise<{ examples: MemoryEntry[]; rules: LearnedRule[] }> {
  try {
    const [examples, rules] = await Promise.all([
      getRelevantExamples({
        language: input.language,
        prefix: input.prefix,
        project_root: input.project_root,
      }),
      getLearnedRules({
        language: input.language,
        prefix: input.prefix,
        project_root: input.project_root,
      }),
    ])
    return { examples, rules }
  } catch {
    return { examples: [], rules: [] }
  }
}
