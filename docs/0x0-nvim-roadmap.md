# 0x0.nvim — Roadmap

The plugin's direction is **solidify the chat → tool-call → review loop**,
not add new surfaces. Each phase is shippable on its own; later phases
build on earlier ones but are not blocking. Out-of-scope work (debug
adapter, remote dev, collaboration, prediction training) is intentional —
those belong in other plugins.

The north-star reference is Zed's Agent Panel final experience: the agent
works in the real project, every AI edit becomes a reviewable item, context
mentions are explicit, and the same keep/reject vocabulary works inline, in
the review tab, and at the whole-run level. The important implementation idea
to copy is not Zed's Rust/GPUI shape; it is the **action-log mental model**:
review UI is a projection of unresolved AI edits, not an independent static
diff buffer.

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

## Phase 2 — Durable review ledger (shipped core)

Zed keeps AI edits in an action log; accepting a hunk removes that hunk from
the review set, and rejecting it restores from the baseline. 0x0.nvim should
have the same semantic guarantee. This phase makes review actions real instead
of cosmetic.

- Add a review ledger on top of the active checkpoint: `{path, hunks,
  status}` with stable hunk signatures and extmark anchors when buffers are
  open.
- Make accept durable:
  - per-hunk accept removes only that hunk from unresolved review state;
  - per-file accept removes that file's unresolved hunks;
  - accept-all stamps/clears the checkpoint only after all unresolved hunks
    are accepted.
- Make reject precise:
  - per-hunk reject restores only the selected hunk from the checkpoint;
  - per-file reject restores that file from the checkpoint;
  - reject-all restores every unresolved change from the checkpoint.
- Refresh all review projections after each action: inline overlays,
  `zxz-review`, changed-file counts, and chat status.
- Add an undo affordance for the last reject where practical, mirroring Zed's
  "last reject undo" behavior.

Implemented in this slice:

- `edit/ledger.lua` is now the single checkpoint-backed accept/reject write
  path.
- Per-hunk/per-file accept rewrites the checkpoint baseline, so accepted work
  cannot be discarded later.
- Per-hunk/per-file reject rewrites only the worktree and keeps unrelated user
  edits outside the target hunk.
- Inline overlays and `zxz-review` refresh from the updated checkpoint diff
  after each action.
- `ZxzUndoReject`, review-buffer `u`, and inline `<localleader>u` restore the
  last rejected change.

Acceptance criteria:

- A hunk accepted from `zxz-review` cannot later be discarded by
  `ZxzChatDiscardAll`.
- A rejected hunk disappears from `zxz-review` and from the inline overlay
  without requiring the user to reopen the review.
- User edits outside the target hunk survive reject.
- Tests cover durable accept/reject for modified files and hunk-accept
  hardening for added/deleted files.

## Phase 3 — Hunk-first review surface (shipped core)

Single scrollable buffer that stitches excerpts from every file an agent
edited in a run. This builds on Phase 2's ledger, so the surface always
reflects authoritative unresolved edit state.

- `edit/review.lua` opens `ft=zxz-review` scratch buffer.
- Data model: `{path, anchor_start, anchor_end, hunks[]}`; anchors as
  extmarks so they survive concurrent edits.
- Rendering: per-file header via `virt_lines`, 3 lines of context,
  elided regions concealed, gitsigns-style sign column.
- Hunk rows are first-class. `a`/`r` act on the hunk under cursor; file and
  run actions are secondary (`A`/`R` or explicit commands).
- `<CR>` opens or focuses the source file in another window while keeping the
  review buffer alive.
- `run_actions` auto-opens review on multi-file runs (config flag).

Implemented in this slice:

- `zxz-review` renders file sections with first-class hunk rows instead of a
  file-first raw diff dump.
- `a`/`r` act on the hunk under cursor for active checkpoint reviews.
- `A`/`R` remain file-scope actions; `ga`/`gr` remain all/run-scope actions.
- `]h`/`[h` navigate hunk rows, not files.
- `<CR>` opens/focuses the source file in a split and jumps to the changed line
  while keeping the review buffer alive.
- Review tests cover hunk accept, hunk reject, source focus, and live shrinkage.

Acceptance criteria:

- Review navigation moves hunk-to-hunk, not only file-to-file.
- The same verbs work from inline overlays and from `zxz-review`.
- The review buffer shrinks as hunks are accepted/rejected.

## Technical Debt / Current Shortcomings

These are known issues in the current implementation and should be retired
before broadening the feature surface too much.

1. **Ledger still has a checkpoint projection layer.**
   Phase 4 now records pending/accepted/rejected status on edit events and
   event hunks, and `zxz-review` renders pending event hunks first. The
   checkpoint/worktree mutation path still projects those statuses through
   `edit/ledger.lua`, though, and old/non-event edits fall back to checkpoint
   diffs. The next step is hardening mixed event + non-event review state so
   those paths cannot disagree.

2. **Fallback edit-event provenance is still heuristic.**
   Pending event hunks render directly from their event diffs, so host-mediated
   writes no longer depend on latest-event-by-path annotation. The fallback
   `EditEvents.annotate_chunks` path still groups events by path and hunk
   index for cumulative checkpoint diffs. That remains unreliable when multiple
   writes touch the same file, when hunks merge/split between event diffs and
   the final checkpoint diff, or when user edits shift the final diff.

3. **Multiple pending events for one file are ordered, not merged.**
   Later pending events for a file now render as blocked file-level rows until
   earlier event hunks are resolved, which avoids stale projection actions. The
   richer Zed-like target is still a merged per-file unresolved view that can
   present independent same-file hunks without forcing strict event order.

4. **Tool-call attribution still depends on a constrained active id.**
   ACP `fs/write_text_file` handling does not guarantee a tool-call id in the
   params, so `fs_bridge.lua` and `run_registry.lua` fall back to
   `active_tool_call_id` only when that tool is still non-terminal. That avoids
   stamping late writes onto completed tools, but overlapping live tool calls can
   still be ambiguous. We need a protocol-level id when available, or a stricter
   correlation model.

5. **Async edit-event recording is best-effort only.**
   Chat and detached write handlers now ACK after the reconcile write succeeds,
   then record edit events asynchronously. That protects provider tool calls
   from review-bookkeeping failures, but failed event recording is currently
   only logged. Add retry/diagnostic visibility if dropped events become common.

6. **Edit-event storage still has no lifecycle.**
   Live events are kept in a process-global `events_by_run` table with no
   eviction. Persisted runs now cap hunk-level event storage and fall back to
   summary-only events for large/binary diffs, but many long-lived Neovim
   sessions can still bloat memory/state. Add event GC and stale-run eviction.

7. **Hunk accept/reject still lacks stable ids.**
   Phase 4 now verifies the rendered hunk block against the checkpoint/worktree
   before applying an action, so stale line numbers fail closed instead of
   patching the wrong region. The remaining gap versus Zed is stable hunk ids
   with provenance, so actions can survive richer rerenders and history views.

8. **Review-buffer hunk reject now has dirty-buffer protection.**
   `Ledger.reject_hunk` and `Ledger.reject_file` refuse to write through an
   open modified source buffer. Keep this guard as the shared choke point for
   any future review surface.

9. **Restore paths are worktree-only now.**
   `Checkpoint.restore_file`, saved-run review restore, and run accept/reject
   restore paths now use blob reads plus disk writes/deletes instead of
   `git checkout`, preserving the user's real git index. Continue auditing new
   restore paths against this rule.

10. **Saved-run review is still file-scoped.**
   `zxz-review` renders run diffs as hunk rows, but `a`/`r` fall back to
   file-level accept/reject for saved runs because there is no run ledger. The
   UI should either mark run review as file-scoped or implement run hunk actions
   against start/end snapshots.

11. **Review rerendering is coarse and loses interaction context.**
   Accept/reject rebuilds the whole review buffer and does not preserve the
   nearest next hunk, viewport, or folds. This works for tests but will feel
   jumpy on large agent edits. Preserve cursor/viewport and prefer incremental
   row updates where possible.

12. **Undo reject is process-global and single-slot.**
   `ZxzUndoReject` stores one in-memory snapshot for the last reject across all
   sessions/checkpoints. It is useful, but not scoped to a chat/run and not
   durable across reload. Scope undo records by checkpoint/run, and clear them
   when their checkpoint is deleted.

13. **Rename and mode-only cases are under-specified.**
   Large and binary host-write events now fall back to summary-only file
   actions, but the parser is still line-based unified diff parsing. It does
   not meaningfully represent renames, mode-only changes, or complex Git diff
   metadata. Review should render those as file-level actions with clear labels
   instead of pretending every diff is hunk-editable text.

## Phase 4 — Streaming-into-buffer

Inline diffs should paint as deltas arrive, not after the tool call
returns.

- Audit `acp_client` + `inline_diff` for batching points.
- `inline_diff.update_hunks_streaming(run_id, file, delta)` incremental
  + idempotent; cursor follows the active hunk when the window is
  focused.
- Same primitive drives multi-line completion preview in
  `complete/ghost`.
- Config flag to disable on slow terminals.

Implemented in the Phase 4 seed slice:

- Host-mediated `fs_write` now schedules a debounced per-path overlay refresh
  while the agent is still running.
- `inline_diff.refresh_path_streaming` coalesces rapid writes and preserves the
  visible cursor/viewport while repainting marks.
- `inline_diff.streaming_refresh` and `inline_diff.streaming_refresh_delay_ms`
  provide the escape hatch for slow terminals.
- Checkpoint tree generation now hashes the actual worktree content instead of
  trusting copied index stat data, so rapid same-size AI edits are detected.

Implemented in the structured edit-event slice:

- Host-mediated writes now produce structured edit events with run id, tool
  call id, path, blob shas, diff text, per-hunk ids, timestamp, and diff stats.
- Edit events are persisted on the run record and linked back to the tool call
  that produced them.
- Chat tool-call rendering shows the files edited by that tool call.
- `zxz-review` hunk rows are annotated with the originating tool call when the
  event stream can identify it.
- Detached runs record the same edit-event shape through `run_registry`.

Implemented in the event-backed review-ledger slice:

- Edit events and event hunks now carry pending/accepted/rejected status.
- Ledger accept/reject actions update event hunk, path, or run status after
  successful checkpoint/worktree projection.
- `zxz-review` prefers pending event chunks and falls back to checkpoint diffs
  for old/non-event changes.
- Pending event hunks disappear from review once accepted or rejected.

Implemented in the robust event-budget slice:

- Chat and detached host writes now respond to ACP after the reconcile write
  succeeds, before edit-event diff/hash/persistence work runs.
- Event recording is bounded and best-effort; failures are logged instead of
  failing the provider write response.
- Large, binary, or over-budget diffs are stored as summary-only file events
  instead of hunk-level review events.
- Summary-only events render as file-level review rows with the guard reason.
- Pending event chunks and checkpoint fallback chunks now merge, so non-event
  files do not disappear when event-backed hunks exist.
- Later same-file event chunks are rendered as blocked file-level rows until
  earlier event hunks are resolved.
- Active-tool fallback attribution is constrained to non-terminal tool calls;
  late writes are recorded as unattributed instead.
- `edit_events.max_content_bytes` and `edit_events.max_diff_bytes` configure
  the hunk-level event budget.

## Phase 5 — Structured context provenance + trim controls

Zed treats mentions as structured context objects (file, symbol, rule,
diagnostics, git diff, thread, fetch, selection, terminal, image), then loads
and formats them at submit time. 0x0.nvim should keep the same separation:
mentions are structured records; the transcript only renders them.

- Store context metadata with each user message:
  `{raw, type, label, source, resolved, error}`.
- Render compact provenance under the user message and a collapsible detail
  view for resolved context.
- `:ZxzContextTrim` opens a toggle buffer for the next turn.
- Track failed context resolution visibly instead of silently omitting it.

Acceptance criteria:

- Chat history can show what context was requested even after reload.
- Failed context loads are visible and do not silently degrade prompts.
- The prompt builder consumes structured context records, not re-parsed
  transcript strings.

## Phase 6 — Rules + prompts library

Disk-backed, no DB.

- `~/.config/0x0/rules/*.md` (global) merged with `.0x0/rules.md`
  (project). Injected into the system prompt; visible in chat header.
- `~/.config/0x0/prompts/*.md` picker via `:ZxzPrompt`; expands into
  the chat input.
- Completion reads rules too — short rules flow into the FIM prompt.

## Next slice

**Finish Phase 4: saved-run hunk actions and protocol attribution.**

The review surface is now event-backed for normal host-mediated writes, bounded
for large/binary edits, and conservative for same-file event ordering. The next
gap versus Zed's final experience is history correctness: saved-run reviews
should support real hunk actions, and write attribution should use protocol ids
instead of active-tool inference where possible.

Concrete scope:

1. Make saved-run hunk actions event-backed instead of file-scoped.
2. Replace `active_tool_call_id` fallback attribution with stricter
   protocol-level correlation where available.
3. Promote blocked same-file event rows into a merged unresolved projection
   where independent hunks can be resolved out of order safely.
4. Add event lifecycle/GC for long-lived sessions.
5. Add diagnostics for dropped best-effort edit events.

## Deferred / not on the roadmap

- MCP `context_server` integration. The earlier unification attempt is
  superseded; revisit only after rules/prompts land and a real user
  asks for it.
- Edit prediction (Zeta-style FIM model training). Completion stays
  prompt-driven through a fast model.
- Debug adapter, remote dev, devcontainer, collaboration, livekit.
