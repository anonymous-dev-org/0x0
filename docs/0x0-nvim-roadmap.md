# 0x0.nvim — Roadmap

The plugin's direction is **solidify the chat → tool-call → diff loop**,
not add new surfaces. Each phase is shippable on its own; later phases
build on earlier ones but are not blocking. Out-of-scope work (debug
adapter, remote dev, collaboration, prediction training) is intentional —
those belong in other plugins.

## Phase 0 — Rename + reorg + fold completion (shipped)

- `apps/chat-nvim` → `apps/0x0.nvim`; namespace `zeroxzero` → `zxz`.
- `lua/zxz/{core,chat,edit,complete,context}/` layout.
- 29 user commands renamed `Zero*` → `Zxz*`.
- `apps/completion-nvim` folded into `lua/zxz/complete/`; deleted from
  disk. ACP plumbing unified under `core/acp_client.stream_completion`
  (per-provider singleton, auto-approve, optional `authenticate`).
- `core/paths.lua` + first-run migration of `~/.local/state/nvim/zeroxzero`
  → `…/0x0`. Git ref prefix `refs/zeroxzero/checkpoints/` →
  `refs/0x0/checkpoints/`.
- `core/events.lua` pub-sub scaffold (no consumers yet).
- All tests pass; stylua clean.

## Phase 1 — Verb unification

One vocabulary for accept/reject across inline diff, run review, and
ghost completion. Goal: any "accept current thing" key works no matter
which surface owns the cursor.

- New `edit/verbs.lua` dispatching by context.
- Keymaps: `]h`/`[h` navigate hunks, `ga`/`gr` per hunk, `gA`/`gR` per
  file, `gqa`/`gqr` per run. `u` always falls back to
  `checkpoint.restore_run()`.
- which-key group `<leader>z`.
- Ghost-text accept feeds the same verb table so the keymap story is
  consistent.

## Phase 2 — Streaming-into-buffer

Inline diffs should paint as deltas arrive, not after the tool call
returns.

- Audit `acp_client` + `inline_diff` for batching points.
- `inline_diff.update_hunks_streaming(run_id, file, delta)` incremental
  + idempotent; cursor follows the active hunk when the window is
  focused.
- Same primitive drives multi-line completion preview in
  `complete/ghost`.
- Config flag to disable on slow terminals.

## Phase 3 — Multi-buffer review surface

Single scrollable buffer that stitches excerpts from every file an agent
edited in a run.

- `edit/review.lua` opens `ft=zxz-review` scratch buffer.
- Data model: `{path, anchor_start, anchor_end, hunks[]}`; anchors as
  extmarks so they survive concurrent edits.
- Rendering: per-file header via `virt_lines`, 3 lines of context,
  elided regions concealed, gitsigns-style sign column.
- Verbs from Phase 1 work here. `<CR>` jumps to source.
- `run_actions` auto-opens review on multi-file runs (config flag).

## Phase 4 — Rules + prompts library

Disk-backed, no DB.

- `~/.config/0x0/rules/*.md` (global) merged with `.0x0/rules.md`
  (project). Injected into the system prompt; visible in chat header.
- `~/.config/0x0/prompts/*.md` picker via `:ZxzPrompt`; expands into
  the chat input.
- Completion reads rules too — short rules flow into the FIM prompt.

## Phase 5 — Context provenance + trim controls

Make the agent feel less magic.

- Chat shows a collapsible card per turn: `rules: 3, prompts: 1,
  auto: repo_map+lsp+recent`.
- `:ZxzContextTrim` opens a toggle buffer for the next turn.

## Deferred / not on the roadmap

- MCP `context_server` integration. The earlier unification attempt is
  superseded; revisit only after rules/prompts land and a real user
  asks for it.
- Edit prediction (Zeta-style FIM model training). Completion stays
  prompt-driven through a fast model.
- Debug adapter, remote dev, devcontainer, collaboration, livekit.
