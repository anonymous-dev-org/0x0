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

3. **Same-file event projection is conservative by design.**
   Independent line-neutral same-file event hunks now merge into one unresolved
   file view and can be resolved out of order. Overlapping hunks, inserts,
   deletes, and summary-only events still become blocked file-level rows because
   their line mapping can become ambiguous after partial resolution.

4. **Tool-call attribution still has protocol coverage limits.**
   `fs_bridge.lua` and `run_registry.lua` now share a protocol-first
   attribution resolver. Explicit write params such as `toolCallId`,
   `tool_call_id`, and nested `toolCall.toolCallId` win over fallback. Active
   fallback is only used when exactly one non-terminal tool is attachable;
   overlapping live tools are marked `ambiguous_active`. The remaining gap is
   provider-specific protocol fields we have not observed yet.

5. **Async edit-event recording is best-effort only.**
   Chat and detached write handlers now ACK after the reconcile write succeeds,
   then record edit events asynchronously. That protects provider tool calls
   from review-bookkeeping failures. Failed event recording now creates a
   run-level diagnostic and an informational review row, but there is still no
   retry queue. Add retry only if real provider traffic shows transient drops.

6. **Edit-event storage lifecycle is intentionally simple.**
   Live events and diagnostics now share a process-global lifecycle with
   age-based and retained-run GC. Persisted runs still own durable history;
   in-memory GC only controls live review projection state. Revisit if we need
   cross-session unresolved event caches beyond the run store.

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

10. **Saved-run non-event hunks still have no durable ledger.**
   Event-backed saved-run hunks now support real `a`/`r` actions and update
   event status. Old/non-event saved-run hunks can still be applied one hunk at
   a time, but without event ids they do not have durable resolved status beyond
   the current projection. Prefer event-backed runs for durable history.

11. **Review rerendering is still whole-buffer.**
   Accept/reject rebuilds the whole review buffer, but now restores the window
   view and moves the cursor to the nearest remaining unresolved hunk. This is
   good enough for normal review loops. The remaining polish is incremental row
   updates/fold preservation if large reviews still feel jumpy.

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

Retired in the technical-debt hardening pass:

- Host-mediated file access is now repo-confined. ACP file paths are
  canonicalized and rejected when absolute paths or `..` traversal would escape
  the active repo root.
- Saved-run accept/reject now validates the worktree before restoring run
  snapshots. Whole-run actions refuse unsafe paths, modified source buffers,
  and files whose current contents no longer match the run start/end state.
- Transcript code jumps now preserve review/picker/help layouts by targeting
  only normal named code buffers, opening a split when no suitable source
  window exists.
- Hunk-scoped ask/edit now carries parsed diff hunk context, including old-side
  deleted lines, so deletion-heavy hunks do not degrade to adjacent surviving
  code only.
- Tool transcript row invalidation now uses an edit-event signature, not just
  row count, so same-row changes to stats, paths, summary reasons, or hunk
  headers rerender correctly.

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
- Protocol tool ids on host write params are preferred over active-tool
  inference, and ambiguous overlapping tool writes are recorded explicitly.
- Saved-run review hunk actions apply only the selected hunk against the
  current worktree and update event hunk status when provenance is available.
- `edit_events.max_content_bytes` and `edit_events.max_diff_bytes` configure
  the hunk-level event budget.

Implemented in the event lifecycle + diagnostics slice:

- `edit_events.max_retained_runs` and `edit_events.max_age_seconds` bound the
  live process-global edit-event and diagnostic stores.
- Recording a live edit event or diagnostic triggers GC so long-lived Neovim
  sessions do not retain every run indefinitely.
- Chat and detached write paths record run-level diagnostics when asynchronous
  edit-event bookkeeping fails after a successful write.
- Dropped-event diagnostics render as informational `zxz-review` rows, while
  the normal checkpoint fallback diff remains reviewable.

Implemented in the merged same-file projection slice:

- Same-file pending event hunks are merged into one `zxz-review` file section
  when their old/new ranges are line-neutral and non-overlapping.
- Independent same-file hunks keep their original event and tool-call
  provenance, so hunk-level accept/reject still updates the right event status.
- Overlapping same-file hunks remain blocked as file-level rows with an
  explicit `overlapping_event_hunks` reason.
- Inserts, deletes, and summary-only events stay conservative because resolving
  them can shift later hunk coordinates.

Implemented in the review interaction polish slice:

- Review accept/reject rerenders now restore the window view instead of leaving
  the cursor on whatever row happens to survive the rebuild.
- Hunk actions move to the nearest remaining unresolved hunk, preferring the
  next hunk at or after the original row and falling back to the previous hunk.
- File actions use the same post-action hunk targeting, so multi-file reviews
  stay keyboard-driven after resolving a whole file.

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

Implemented in the structured context provenance seed slice:

- User messages now persist structured context records alongside the compact
  legacy summary: `{raw, type, label, source, resolved, error, start_byte,
  end_byte}`.
- The transcript renders context provenance from those stored records first,
  so reloaded history does not need to re-parse old prompt text to show what
  the user attached.
- Unresolved `@tokens` are preserved as `unknown` records instead of silently
  disappearing from the provenance line.
- Unavailable first-class context sources, currently `@terminal`, render as
  unresolved records with an explicit error.

Implemented in the trim-controls slice:

- `:ZxzContextTrim` opens a floating picker showing the records parsed from
  the current chat input. `<Tab>`/`x`/`<Space>` toggles a record, `<CR>`
  applies the decision, `q`/`<Esc>` cancels.
- Applied decisions are stored on the Chat as `pending_trim: { [raw]=true }`
  and consumed at submit time. Suppressed records are dropped from the
  provider blocks and marked `trimmed = true` on the persisted user message.
- The transcript renders trimmed records as `@token (trimmed)` so the user
  can see what was withheld without re-parsing the prompt.
- `pending_trim` is cleared after each submit, so a trim decision applies
  only to the next turn.

Implemented in the records-driven prompt builder slice:

- Context records now embed the full parsed mention payload, so provider
  prompt blocks are derived from the same record list that drives transcript
  rendering instead of being re-parsed from raw prompt text.
- `ReferenceMentions.to_prompt_blocks_from_records(input, records, cwd)`
  builds blocks from a record list; `to_prompt_blocks` is now a thin wrapper
  over `records() → to_prompt_blocks_from_records`.
- `_submit_prompt` recomputes records once at send time and passes them into
  the block builder, so context selection used by the transcript and by the
  provider always agree.
- Queued message edits recompute context records and the compact summary, so
  swapping `@a.txt` for `@b.txt` in a queued prompt no longer leaves stale
  provenance attached to the user message.
- Unresolved/unknown records remain visible in the transcript but contribute
  no provider block, except for explicit fallback types like `@terminal` whose
  formatter already emits a "not available" message.

Implemented in the Phase 5 wrap-up slice:

- The transcript can now expand per-user-message context detail in place with
  `<localleader>o` on the user/context row. Detail lines show each record's
  label, type, source, byte range, trim/unresolved state, and error.
- Queued prompts carry their own trim map and context record snapshot, so
  multiple queued messages can preserve different suppress/keep choices.
- Editing a queued prompt filters the prior trim map against the edited
  records, preserving suppressions for unchanged `@tokens` and dropping stale
  ones.
- `:ZxzContextTrim 2` opens the trim picker for queued message 2, and the
  queue picker exposes the same trim action from the queued-message menu.

Implemented in the Phase 5 hardening slice:

- Active prompts apply trim before the first transcript render, so the context
  line matches what the provider will receive even while the session is still
  starting.
- Session reset/new/load clears pending trim state, preventing stale
  suppressions from leaking into a later prompt.
- Transcript reset clears context-detail expansion state, so user-message ids
  from a previous thread do not expand unrelated context records.
- Focused tests cover active-trim rendering, queued trim preservation, and
  reset hygiene.
- Automatic queue drain preserves each queued prompt's stored context records
  and trim map, so a queued prompt sends the same context that the transcript
  shows.

Acceptance criteria:

- Chat history can show what context was requested even after reload.
- Failed context loads are visible and do not silently degrade prompts.
- The prompt builder consumes structured context records, not re-parsed
  transcript strings.
- Context decisions remain inspectable and adjustable for queued turns before
  the provider receives them.
- Queued prompts preserve context decisions whether they are sent manually or
  drained automatically.
- Trim/detail UI state is scoped to the current turn or current transcript and
  does not leak across sessions.

## Deferred — Rules + prompts library

Disk-backed configuration work. Useful later, but not part of the core
AI-first IDE loop right now.

- `~/.config/0x0/rules/*.md` (global) merged with `.0x0/rules.md`
  (project). Injected into the system prompt; visible in chat header.
- `~/.config/0x0/prompts/*.md` picker via `:ZxzPrompt`; expands into
  the chat input.
- Completion reads rules too — short rules flow into the FIM prompt.

## Next slice

**Code-anchored co-working navigation.**

Phase 5 now covers durable context provenance, records-driven provider prompts,
trim controls, queued-message trim, in-transcript context details, and trim
state hygiene. The next AI-first IDE slice should make the chat/review surface
feel directly attached to the codebase:

Implemented in the context-navigation seed slice:

- Expanded context details render as real transcript rows, not virtual-only
  decoration, so cursor actions can target individual records.
- `<CR>` on a resolved file or range context detail row opens the source file
  in a code window and jumps to the referenced line/range.
- Trimmed, unresolved, and non-file context rows remain visible but inert, so
  withheld or unavailable context does not accidentally navigate.

Implemented in the tool-navigation seed slice:

- Tool edit-event rows render as real transcript rows with one row per touched
  file and one child row per recorded hunk.
- `<CR>` on a tool edit file row opens the touched file, preferring the first
  recorded hunk when available.
- `<CR>` on a tool hunk row opens the touched file at that hunk's new-side
  line, so tool output can take the user directly to code.
- Rendered tool calls rerender when asynchronous edit-event bookkeeping later
  attaches touched-file rows.

Implemented in the hunk co-working action slice:

- Transcript hunk rows now support `<localleader>a` to open inline ask against
  that exact hunk range.
- Transcript hunk rows now support `<localleader>e` to open inline edit against
  that exact hunk range.
- Inline ask accepts an explicit range, so hunk-scoped questions send focused
  code instead of only generic surrounding cursor context.

Implemented in the review-refresh stability slice:

- Open review buffers preserve the logical selected file/hunk across checkpoint
  refreshes, so streaming edits do not move the cursor to a different hunk when
  rows are inserted above it.
- Streaming inline-diff refreshes notify the review surface after the debounced
  overlay update, keeping review and source overlays in sync while the agent is
  still writing.

Implemented in the compact work-state slice:

- The existing transcript footer now shows compact live run state while the
  agent is working: running tool, touched files, pending review count, conflicts,
  and blocked/diagnostic review items.
- The footer uses cheap in-memory run state instead of polling Git on the
  spinner timer, so the status stays live without making the chat UI heavy.

Implemented in the final stabilization pass:

- The compact work-state footer is width-aware, so long tool titles or touched
  paths do not push noisy virtual text across the chat split.
- If the tracked active tool id is stale or already terminal, the footer falls
  back to the latest non-terminal tool call instead of losing the running-tool
  signal.

Remaining scope:

- The core co-working navigation plan is implemented. Keep the next slice to
  cleanup, correctness, and UX tightening unless a real missing workflow shows
  up in daily use.

Rules/prompts remain deferred configuration work; revisit only after the core
co-working loop feels complete.

## Deferred / not on the roadmap

- MCP `context_server` integration. The earlier unification attempt is
  superseded; revisit only after rules/prompts land and a real user
  asks for it.
- Edit prediction (Zeta-style FIM model training). Completion stays
  prompt-driven through a fast model.
- Debug adapter, remote dev, devcontainer, collaboration, livekit.
