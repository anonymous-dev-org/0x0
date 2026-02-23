import type { StagedContext } from "./git"

/**
 * Build the prompt for commit message generation.
 */
export function buildPrompt(ctx: StagedContext): string {
  const fileSection = ctx.files.map((f) => `- ${f}`).join("\n")

  return `You are a commit message generator. Output ONLY the commit message, nothing else.

Rules:
- Use Conventional Commits format: <type>(<scope>): <description>
- Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build
- Scope is optional — use the most relevant module/area if obvious
- Keep the subject line under 72 characters
- Use imperative mood ("add" not "added")
- Add a body after a blank line only if the changes warrant explanation
- Do NOT wrap the message in quotes or code blocks

Files changed:
${fileSection}

Diff:
${ctx.diff}`
}
