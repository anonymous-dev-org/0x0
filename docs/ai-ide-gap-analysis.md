# 0x0 — AI IDE Gap Analysis

**Goal.** Grow 0x0 into a Neovim-native AI IDE driven by Claude and Codex
(plus Gemini today), keeping the human close to the code at every step.

**Scope.** This is a gap analysis, not an implementation plan. It maps
what we have, what an AI-IDE-class experience needs that we don't, and
how the open dimensions sequence against each other. It is the input to
the next implementation planning round(s).

**Status as of 2026-05-11.** Tier 1–2 of the prior plan
(`~/.claude/plans/misty-knitting-lerdorf.md`) plus selective Tier 3
items have shipped:

- G1 Run object · G2 diffview review · G3 runs picker · G4 run-granularity
  accept/reject · G5 live run status · G6 tool-call timeline ·
  G7 cancel-path audit · G8 reconcile-conflict surfacing ·
  G11 per-path tool policy · G12 queued approval requests ·
  G13 headless runs (`:ZeroChatRun`).

Still pending from that plan: G9 (parallel agents), G10 (MCP unification
— since superseded; see `~/.claude/projects/.../memory/project_mcp_unification.md`).

---

## What 0x0 already does as an AI IDE

| Area | Today |
|---|---|
| Chat surface | Per-tabpage sidebar; 4 providers (claude-acp, claude-agent-acp, codex-acp, gemini-acp); model/mode picker; history picker |
| Context attach | `@path` mention completion; visual-selection attach; hunk attach; current-file attach |
| Agent execution | ACP turn lifecycle; tool gating by kind + per-path policy; permission queue; cancellation |
| Diff review (live) | Per-turn checkpoint via hidden git refs; virt_lines inline overlay; `]h`/`[h` nav; per-hunk and per-file accept/reject |
| Diff review (post-hoc) | Run objects with `start_ref`/`end_ref`; `:ZeroChatRunReview` opens diffview; `:ZeroChatRunAccept/Reject` |
| Observability | Run history per thread; tool-call timeline; live run header (tool count, files, elapsed); reconcile-conflict markers |
| Headless mode | `:ZeroChatRun <prompt>` without opening the sidebar; completion notify |
| Completion | `apps/completion-nvim` ghost-text via ACP; accept/dismiss keys; basic cache |

ACP already provides the unified transport across all four providers —
the historic "unify Claude/Codex" goal is met.

---

## What an AI IDE needs that we don't have

Four dimensions, each genuinely independent of the others. Within each
dimension, gaps are ordered by leverage.

### Dimension A — Inline AI primitives

The Cursor/Zed-with-AI pattern: never leave the buffer to ask the agent
something. Today 0x0 requires opening the sidebar for any agent
interaction. For an IDE feel, the most-used affordances should be
buffer-local.

**A1. Inline edit at cursor / selection.** `<localleader>e` (or similar)
opens a small floating prompt anchored at the cursor or visual selection.
Submitting sends a focused prompt: "edit this region with this
instruction." Result lands as a virt_lines preview overlaying the region;
`<localleader>a`/`r` accept/reject. **Reuse:** `checkpoint.lua` already
snapshots; `inline_diff.lua` already renders virt_lines overlays — the
inline-edit flow is a one-shot, single-file specialization of the
existing live review.

**A2. Inline ask at cursor / selection.** `<localleader>?` (or similar)
opens an answer popup (floating window) without modifying the buffer.
Question gets the cursor symbol + N lines of context. Answer rendered
inline; `q` to dismiss. **Reuse:** transcript renderer's markdown
formatting code in `chat_widget.lua` (or a new minimal popup).

**A3. Code actions backed by agent.** Treesitter-aware actions on the
symbol or selection under cursor: "explain", "write tests", "refactor
to X", "find usages and update", "summarize file", "add docstring".
Surfaced via `vim.ui.select` (or the system `:vim.lsp.buf.code_action`-
style menu). Each action is a templated prompt routed through the
inline-edit or inline-ask pipeline above.

**A4. Quick attach without `@` typing.** A keymap to "attach current
LSP hover," "attach current symbol's definition file," "attach this
diagnostic." Reduces the manual prompt-engineering burden.

**A5. Cursor-context auto-prelude.** Even the sidebar chat would benefit
from automatic preamble: "cursor at `apps/foo.lua:142`, function `bar`,
in scope: …" prepended invisibly. Optional, off by default.

**Critical files for A:**
`apps/chat-nvim/lua/zeroxzero/inline_diff.lua` (overlay primitive),
`apps/chat-nvim/lua/zeroxzero/checkpoint.lua` (snapshot primitive),
`apps/chat-nvim/lua/zeroxzero/chat/run_review.lua` (per-file accept/reject
plumbing — reuse for the inline-edit overlay), plus new modules
`zeroxzero/inline_edit.lua`, `zeroxzero/code_actions.lua`.

---

### Dimension B — Deep code context

The agent's output quality is bounded by the quality of its input. Today
context is whatever the user manually `@`-mentions plus whatever the
provider's built-in tools fetch. An IDE has rich latent context (LSP
diagnostics, hover, definitions, references, the project tree, recently-
edited files, the failing test, the git blame on the cursor line) — that
should be feedable.

**B1. LSP diagnostics piping.** When asking the agent about the current
buffer or running an autonomous run, automatically include
`vim.diagnostic.get(bufnr)` errors/warnings as context. **Reuse:**
nothing; it's a new context provider. Toggle in config.

**B2. LSP hover/definition piping.** When the cursor is on a symbol,
include the hover string and the first N lines of its definition in the
auto-prelude (A5) or as an opt-in mention syntax (`@symbol`).

**B3. Repo map / project digest.** A periodically-built tree of the
repo's top-level structure (filenames, top-of-file docstrings, primary
exports), kept small enough to fit in a system prompt. **Reuse:**
treesitter for symbol extraction; `Checkpoint.git_root` for repo
boundary. Inspired by aider's repo-map.

**B4. Last-N edited files context.** Track recently-modified buffers and
offer them as a one-keystroke attach.

**B5. Test runner integration.** Run the project's test command, capture
output, attach as context. Optionally let the agent loop: edit → test →
read output → edit again. **Reuse:** the existing tool-call event stream
already supports this on the provider side; we just don't surface a
human "run tests now and feed them in" affordance.

**B6. Selection-aware context.** When the user `@`-mentions a path
without a range and the buffer is too large, summarize/index rather than
attaching raw. Compose with B3.

**Critical files for B:**
new module `zeroxzero/context/lsp.lua` (diagnostics, hover, definition);
new module `zeroxzero/context/repo_map.lua` (treesitter-backed digest);
extend `zeroxzero/reference_mentions.lua` to recognize new mention kinds
(`@diagnostic`, `@symbol`, `@test-output`).

---

### Dimension C — Parallel autonomous agents (G9 from the prior plan)

The Devin/Cursor-background-agents pattern: kick off multiple agents and
review them when they finish. Today 0x0 is one-session-per-tabpage and
one-turn-at-a-time-per-session.

**C1. Per-run isolation.** Two agents touching the same file in the
working tree will conflict. Options: (a) per-run git worktree (reverses
part of `docs/inline-diff-plan.md`); (b) per-run branch with stash/pop;
(c) only one run at a time in a given path. **Reuse:** `checkpoint.lua`
already produces commit-tree refs that could anchor a worktree.

**C2. Runs registry.** A global registry (not just per-tabpage) of in-
flight Runs. Required to render any kind of dashboard.

**C3. Run dashboard.** A picker or floating panel listing live + recent
runs with progress, current tool, agent, files touched. **Reuse:**
existing `runs_store.list()`, `current_run` per chat; needs a global
view that aggregates across tabpages.

**C4. Spawn-without-tab.** `:ZeroChatSpawn <prompt>` creates a Run
detached from any tabpage. `:ZeroChatRun` (G13) already does headless
on the current tab — generalize to a new isolated session.

**C5. Cross-run dependencies.** "Agent B waits until Agent A's run
finishes." Out of scope until C1–C4 are stable.

**C6. Resource caps.** Per-project max concurrent runs (default 1
preserves current behavior). Avoid runaway provider subprocesses.

**Critical files for C:** new module `zeroxzero/run_registry.lua`;
extend `chat.lua` tabpage registry to flat run registry; possible new
`zeroxzero/dashboard.lua`. The biggest open question is C1 (isolation
strategy) — see Open Questions.

---

### Dimension D — Own the Claude side (`claude-agent-server`)

Today `claude-acp` and `claude-agent-acp` point at external binaries
(`claude-code-acp`, `claude-agent-acp`). We have zero control over their
tool sets, system prompts, capability negotiation, or update cadence.
This is the only ACP provider we don't own.

**D1. `claude-agent-server` in-repo (TypeScript).** A new package
mirroring the pattern of the existing `codex-acp` and the external
`claude-code-acp`. Speaks ACP over stdio. Wraps `@anthropic-ai/sdk`
for completion. Replaces the external dep in `config.lua`. **Reuse:**
`acp_client.lua` and `acp_transport.lua` are protocol-agnostic about
the *server* — they just need an ACP-speaking binary on the other end.

**D2. Custom tool definitions.** Once we own the server, we can register
project-aware tools: `find_in_repo` (treesitter-backed), `run_tests`,
`apply_inline_edit`, `read_with_lsp_context`. The host fs-bridge stays
intact so writes still flow through `reconcile.lua`.

**D3. Project-aware system prompt.** Inject repo map (B3) and project
conventions into the system prompt server-side.

**D4. Agent memory.** Persist per-project "what the agent learned" across
runs. Cursor's `.cursorrules` / Aider's conventions equivalent. Lives in
the server, not the client.

**D5. Capability negotiation.** Expose 0x0-specific capabilities in the
initialize response so chat-nvim can light up server-aware UI without
guessing.

**Critical files for D:** new `apps/claude-agent-server/` TypeScript
package (package.json, src/index.ts, src/acp.ts, src/tools.ts);
`apps/chat-nvim/lua/zeroxzero/config.lua` to point the provider at the
new local binary; no protocol changes in chat-nvim itself.

---

### Dimension E — `completion-nvim` upgrades (orthogonal but cheap wins)

**E1. Multi-line completions.** Today the ghost-text model assumes a
single continuous line.

**E2. LSP-aware context.** Feed the completion server hover/import info
for the symbol about to be completed. Composes with B2.

**E3. Accept/reject telemetry.** Cache hit/miss rate; what's actually
accepted. Feeds prompt tuning.

**E4. Suppress in comments/strings.** Treesitter-gated activation.

---

## Sequencing graph

```
A (Inline AI primitives)
  ├── A1 inline-edit       ──┐
  ├── A2 inline-ask         │ all independent of each other
  ├── A3 code actions       │ A3 depends on A1+A2 plumbing
  ├── A4 quick attach       │
  └── A5 auto-prelude       ─┘ (composes with B)

B (Deep code context)
  ├── B1 LSP diagnostics    ──┐ independent
  ├── B2 LSP hover/def      │ B2 unlocks better A1+A2
  ├── B3 repo map           │ B3 unlocks D3 (project-aware prompt)
  ├── B4 recent files       │ independent
  ├── B5 test integration   │ B5 needs nothing else
  └── B6 selection-aware    ─┘ depends on B3

C (Parallel agents)
  └── C1–C6 all internally sequential; C1 is the gating decision

D (claude-agent-server)
  ├── D1 the server itself   ─── prereq for D2–D5
  ├── D2 custom tools         ─── unlocked by D1; benefits from B3
  ├── D3 project-aware prompt ─── unlocked by D1+B3
  ├── D4 memory               ─── unlocked by D1
  └── D5 capabilities         ─── unlocked by D1

E (completion-nvim)
  ├── E1–E4 independent of A/B/C/D
```

**Cross-dimension dependencies:**
- A3 (code actions) heavily benefits from B2 (LSP hover/def)
- A5 (auto-prelude) benefits from B1 (diagnostics) and B3 (repo map)
- D3 (project-aware prompt) and D4 (memory) benefit from B3 (repo map)
- C (parallel) is mostly orthogonal but the dashboard is more useful
  once D (we own server) lights up richer status

---

## Recommendation for the next planning round

Three reasonable next planning targets, ranked by leverage-per-week:

1. **A (Inline AI primitives).** The single largest user-facing gap vs.
   Cursor/Zed. Every gap A1–A5 is small (≤200 LOC each), independent,
   buffer-local, reuses existing primitives. Highest payoff per LOC.
2. **D1 (claude-agent-server only, no D2–D5 yet).** Self-contained
   sub-project. Doesn't change chat-nvim. Establishes the foundation for
   future control-plane work (D2–D5, B3 server-side). Estimable: ~1
   week of focused TS work.
3. **B (Deep code context).** Higher leverage on existing flow's
   quality. Better tackled after A is live because A creates the
   surfaces where context most matters.

C (parallel) is high-impact but high-cost; its prerequisite (C1
isolation strategy) is itself a multi-day design problem. Defer until
A and either B or D have landed.

E is cheap polish; bundle a 1-day pass once a major dimension ships.

---

## Verification framework (for whichever plan comes next)

Whichever direction is picked, the next implementation plan should
satisfy:

1. The new affordances are reachable without opening the chat sidebar
   (for A) or with one keymap (for B).
2. No regression in the existing G1–G13 surfaces: live diff, run
   review, runs picker, accept/reject, headless run.
3. `make test` green; `make lint` green (stylua locally; CI runs `--check`).
4. New modules carry minimal but meaningful specs for the protocol-
   shaped pieces (e.g., D1 needs an integration spec that the new ACP
   server speaks the protocol the existing `acp_client_spec.lua`
   verifies on the client side).
5. `feedback_solidify_over_features.md` rule respected: each new gap
   builds on or polishes existing chat→tool→diff plumbing rather than
   introducing parallel panels.

---

## Open questions to resolve before implementation

1. **Inline-edit interaction model.** Floating prompt at the cursor
   (Cursor-like) or a Telescope-style popup? Should the diff preview
   block typing or be non-modal?
2. **Inline vs sidebar provider/model selection.** Does the inline-edit
   keymap inherit the tabpage's chat session settings, use a separate
   "quick" model (e.g. always haiku for inline), or both with a toggle?
3. **Repo map size + invalidation.** When to rebuild B3 (every save?
   every Nth save? on git-checkout?). Memory budget?
4. **Per-run isolation (C1).** Worktree return is the simplest mental
   model but reverses an architectural decision. Branch-per-run with
   stash is messy under concurrent user edits. Single-active-run is the
   "honest" default. Pick one before starting C.
5. **claude-agent-server transport vs spawn model.** Long-lived shared
   process across all tabpages, or one per session like today? Affects
   D4 (memory) significantly.
6. **Tool ownership boundary in D2.** Which tools live server-side
   (claude-agent-server) vs. host-side (chat-nvim's fs-bridge)? Default:
   anything that touches the user's filesystem stays host-side so
   `reconcile.lua` keeps governing it.
7. **Context budget management.** A5 + B1–B3 can balloon prompts. Need
   a token-aware budget allocator. Provider-dependent; ACP doesn't
   report token counts uniformly.
8. **Default keymaps.** Inline-edit, inline-ask, code-actions — what
   leader-prefixed bindings? Conflict-check against common nvim setups.
