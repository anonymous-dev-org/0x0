# 0x0 Inline Collaborative Diff — Implementation Plan

## 1. Architectural change in one sentence

The agent writes directly to the user's working tree instead of into a parallel
`git worktree`; we keep a per-turn git checkpoint as the diff baseline; the diff
is rendered as `virt_lines` extmarks on the live buffers; user and agent share
the same files.

## 2. Mutation point being moved

|                       | Today                                                          | After                                                                  |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ACP `cwd`             | `worktree.cwd` (parallel checkout)                             | repo root                                                              |
| Agent writes land in  | shadow worktree files                                          | user's real files                                                      |
| Root mutation         | only at `accept_all` via `git apply` (`shadow_worktree.lua:202`) | as the agent writes (no separate apply step)                           |
| Diff baseline         | shadow worktree HEAD                                           | hidden checkpoint ref `refs/zeroxzero/checkpoints/<turn-id>`           |
| Review surface        | diffview tab                                                   | inline `virt_lines` on live buffers                                    |

## 3. Module diff

### Added

- `checkpoint.lua` (~80 LOC). Owns the hidden ref namespace.
  - `M.snapshot(root) -> {sha, ref}` — `git stash create`-style commit-tree of
    working tree (including untracked) onto a hidden ref.
  - `M.diff(ref, root) -> { [path] = hunks[] }` where each hunk is
    `{old_range, new_range, lines, type}`.
  - `M.reverse_apply_hunk(ref, path, hunk)` — reject one hunk: build a
    single-hunk reverse patch, `git apply -R --cached -` then write back. (Or:
    rewrite file from `ref:path` for that range.)
  - `M.restore_file(ref, path)` — full-file reject.
  - `M.gc(keep_n)` — prune old checkpoint refs.

- `inline_diff.lua` (~250 LOC). Renders + manages the per-buffer overlay.
  - `M.attach(bufnr, hunks)` — places extmarks: `virt_lines` for removed lines
    (red), `hl_eol` line-highlight for added lines (green), gutter signs for
    hunk start, virt_text `[a/r]` hint at first line of each hunk.
  - `M.refresh(bufnr)` — recompute hunks from `checkpoint.diff` and re-decorate.
  - `M.detach(bufnr)`, `M.next_hunk()`, `M.prev_hunk()`,
    `M.accept_hunk_at(cursor)`, `M.reject_hunk_at(cursor)`.
  - Autocmd: `BufWritePost` triggers `refresh`.
  - Per-buffer keymaps (only while overlay is attached): `<localleader>a` accept
    hunk, `<localleader>r` reject hunk, `]h` / `[h` jump.

- Changes surface (no separate module). Implemented as `chat.M.changes()` plus
  inline rendering in `chat_widget.lua`: a transcript section listing files
  edited since the active checkpoint, with jump-to behavior. Replaces what the
  diffview tab gave us. The originally-planned `changes_panel.lua` was folded
  in here to avoid a module that would have only had one caller.

### Changed

- `chat.lua`
  - Drop `_ensure_worktree`. Replace with `_ensure_checkpoint(turn_id)` that
    calls `checkpoint.snapshot` if no current checkpoint, or rolls forward
    (new checkpoint = current HEAD + working tree) on each new user submission.
  - `client:new_session(...)` now passes repo `root`, not `worktree.cwd`.
  - Tool-call handler (`_handle_update`, ~`chat.lua:247`) gains: after each
    `tool_call_update` whose status is "completed" and that touched a path,
    call `inline_diff.refresh(bufnr_for_path)` and update `changes_panel`.
  - Permission gate stays exactly as is — still mediates writes; only difference
    is the writes hit the user's real file once approved.
  - `accept_all` becomes "advance checkpoint to HEAD" (commit the agent edits as
    a regular commit if `auto_commit=true`, otherwise just bump the checkpoint
    forward and clear overlays). `discard_all` becomes "restore working tree
    from checkpoint" (`git checkout <ref> -- .` plus `rm` for new files).

- `init.lua`
  - `:ZeroChatAcceptAll` / `:ZeroChatDiscardAll` semantics updated; commands
    stay.
- `:ZeroChatReview` opens a side-by-side `vimdiff` against the checkpoint for
  users who want a familiar review tool in addition to inline overlays.

### Removed

- `shadow_worktree.lua` — entire file. Its responsibilities split between
  `checkpoint.lua` (baseline) and direct agent-to-root writes (no parallel
  checkout needed).
- `diff_preview.lua` — entire file. Replaced by `inline_diff.lua` +
  `changes_panel.lua`. The `diffview.nvim` runtime dependency goes away.
- `:ZeroReviewAcceptAll` / `:ZeroReviewDiscardAll` / `:ZeroReviewClose` — stale
  aliases.

## 4. Collaborative-edit reconciliation

Two failure modes to handle, both at agent-write time, **before** disk write:

**(a) User edited a file the agent now wants to write.** ACP sends a `tool_call`
for `write_file` or `str_replace`. Plugin mediates it. Compare:

- `expected = checkpoint:read(path)` (or last-cached agent-side view of the
  file)
- `actual = current_buffer_or_disk(path)`

If `expected != actual`, user touched it since checkpoint. Two responses,
configurable:

- **strict** (default): inject an ACP `tool_call_response` with
  `error = "user has edited <path>; here is the diff: ..."`, then refuse the
  write. Model retries with new context. (cline's "feed userEdits back" model.)
- **force**: write anyway, but stash the user's hunks so reject can restore
  them.

**(b) User typing in a buffer the agent is mid-streaming.** Buffer is editable;
we never lock. After agent's write completes, recompute hunks; if the user's
edit overlaps an agent hunk, that hunk's anchors no longer match — drop it
(vscode-copilot's anchor-rebase model) and surface a one-line warning in the
chat transcript.

The reconciliation lives in a small `reconcile.lua` (~50 LOC) called from the
tool-call mediator.

## 5. Checkpoint lifecycle

```
user submits prompt T
  └─ checkpoint.snapshot(root) -> ref C_T
  ACP turn runs
    ├─ tool_call write_file foo.lua
    │   ├─ reconcile against C_T
    │   ├─ permission gate (existing flow)
    │   ├─ write to root/foo.lua
    │   └─ inline_diff.refresh(buf for foo.lua)
    └─ ... more tool calls
  turn ends
  user reviews, hits per-hunk a/r
    ├─ a: clear overlay for that hunk (file already has it)
    └─ r: reverse-apply hunk → rewrite affected lines from C_T
  user submits prompt T+1
  └─ checkpoint.snapshot(root) -> C_{T+1} (replaces C_T as active baseline)
```

`checkpoint.gc(keep_n=20)` runs on chat close. Old checkpoints become reachable
only via `git reflog`-style listing for "show me what changed N turns ago"
(future feature).

## 6. ACP-specific notes

- ACP's `session/request_permission` flow is unchanged. Direct writes do not
  bypass it — permission still gates the disk write.
- ACP `fs/read_text_file` (if the backend uses host-mediated reads) should be
  intercepted to **record the agent's view of each file** so reconciliation has
  a precise "expected" baseline. If the backend reads files itself, fall back
  to the checkpoint blob as the baseline.
- ACP file paths are absolute. Map path → bufnr via `vim.fn.bufnr(path)`; if
  the file isn't open, `inline_diff` is deferred and runs on `BufReadPost` for
  that path.
- The `cwd` we pass to `client:new_session` becomes the repo root from
  `git rev-parse --show-toplevel`. This is also what enables
  agent-and-user-share-files.

## 7. Phasing (ship incrementally)

**Phase 1 — Plumbing (no UX yet).** Add `checkpoint.lua`. Wire
`_ensure_checkpoint` in `chat.lua`. Switch ACP `cwd` to root. Keep
`shadow_worktree.lua` and `diff_preview.lua` alive but unused so we can compare.
`:ZeroChatChanges` opens a plain `:Gdiff <ref>`-equivalent for sanity checking.
Ship behind a config flag `inline_diff = true | false`.

**Phase 2 — Inline overlay.** Add `inline_diff.lua`. Hook `tool_call_update`
→ `refresh`. Add per-hunk keymaps. Add `changes_panel.lua` to chat transcript.

**Phase 3 — Reconcile.** Add `reconcile.lua` and the strict/force config.
Intercept ACP read calls for "agent view" baseline.

**Phase 4 — Cleanup.** Delete `shadow_worktree.lua`, `diff_preview.lua`, the
`Review*` commands. Drop the config flag (inline becomes the only path).
Update docs. **(done)**

Specifically, removed in Phase 4:
- `shadow_worktree.lua`, `diff_preview.lua` (entire files)
- `:ZeroReviewAcceptAll`, `:ZeroReviewDiscardAll`,
  `:ZeroReviewClose` user commands
- `Chat:_ensure_worktree`, `_clear_worktree`, `_show_worktree`, `show_diff`,
  `_add_review_activity` methods + the `worktree` field
- `inline_diff` config key (host-fs + checkpoint is now the only path;
  `acp_client.new` is always called with `host_fs = true`)
- `diffview.nvim` runtime dependency

## 7a. Phase 3 — implementation notes (post-merge)

Captured while wiring `reconcile.lua` so Phase 4 / followups don't re-derive.

1. **Capability flip is what enables host-mediated IO.** Setting
   `clientCapabilities.fs.{readTextFile,writeTextFile} = true` at `initialize`
   is what causes the agent to send `fs/read_text_file` / `fs/write_text_file`
   requests to the host. We toggle this from `chat.lua` based on
   `config.current.inline_diff` when constructing `acp_client.new`.
2. **Backends honor the cap differently.** Verified locally with
   `claude-code-acp`. `codex-acp` and `gemini-acp` are untested — Phase 4 should
   smoke-test each. If a backend writes directly even with cap = true, strict
   refuse is silently bypassed; the post-write `InlineDiff.refresh_all` from
   Phase 2 still catches the change.
3. **Inbound JSON-RPC requests reuse `notification_handlers`.** ACP transport
   doesn't differentiate inbound notifications vs requests; both arrive in
   `_on_message` with `method` set and `result/error` unset. Handlers keyed in
   `notification_handlers` get `(params, message_id)`; if `message_id ~= nil`,
   it's a request and handler must call `respond` or `respond_error`.
4. **`respond_error` was added to `acp_client.lua`.** Strict-mode refusals come
   back to the agent as `{ error: { code: -32000, message: "user has edited..."}}`
   plus a unified diff in the message body (cline's `userEdits` model).
5. **`agent_view` is a per-turn cache.** `Reconcile:set_checkpoint(cp)` clears
   it because a new turn = new checkpoint = previous-turn reads are stale.
6. **Slice vs baseline.** `fs/read_text_file` supports `line`/`limit` params.
   We respond with the slice but cache the *full* file in `agent_view`. The
   conflict baseline must be the whole file or partial reads would falsely
   pass.
7. **Path resolution.** ACP paths "should" be absolute; we defensively join
   relative paths onto `repo_root`. Outside-of-repo absolute paths are passed
   through (no sandboxing). Hardening is a separate pass.
8. **Force mode does not stash user hunks.** Plan §4 mentioned stashing user
   hunks so `reject` can restore them under force mode. Currently force just
   overwrites; user must `:ZeroChatDiscardAll` to recover. Cheap to add later
   via a sidecar ref; deferred.
9. **New-file writes bypass reconcile.** No prior `agent_view`, no checkpoint
   blob → no expected baseline → write proceeds. Matches cline behavior.
10. **Inline overlay refresh ordering.** After `write_for_agent` succeeds we
    call `InlineDiff.refresh_path` synchronously so the overlay appears before
    the agent's `tool_call_update completed` arrives. Prevents a flicker where
    the user sees the new disk content without a diff overlay.
11. **acp_client `host_fs` is opt-in per-client.** Other (non-inline) call
    sites still pass `host_fs = false`, preserving existing behavior. Phase 4
    can drop the option entirely once `inline_diff` is the only path.

## 8. Open questions — resolved

1. **Auto-commit after a turn?** **No.** Hidden checkpoint refs already give
   "rewind a turn" without touching HEAD; auto-committing pollutes branch
   history and surprises users who treat `git log` as the narrative. A separate
   opt-in `:ZeroChatCommit` (uses the chat title as the message) is the future
   path if we want it. Not implemented yet.
2. **Repo-not-git case.** **Refuse with an actionable error.** Wired in
   `_ensure_checkpoint`: the message suggests `git init` and explains the
   diff-baseline / rewind requirement.
3. **Untracked files at checkpoint time.** **Captured.** `working_tree_tree`
   does `git add -A` on a temp index, so new files appear as full additions in
   the inline overlay. Question closed.
4. **`.gitignore`'d files the agent edits.** **Always skip; warn on agent
   write.** Ignored files stay out of the checkpoint (current `git add -A`
   behavior). When the agent writes to an ignored path, `chat.lua:_handle_fs_write`
   appends a one-line transcript activity ("wrote `<path>` — outside
   checkpoint, no rewind available") via `Checkpoint.is_ignored`. No config
   flag — keeping `node_modules`/`dist` out of the changes panel is
   non-negotiable; power users who want generated files captured can
   `git add -f` them manually before the turn.
5. **Where does `accept_all` go semantically?** **Stamp the checkpoint, no
   commit.** Matches current behavior and the "review pile → cleared" mental
   model. Pairs with the opt-in `:ZeroChatCommit` from #1.

## 9. Reference: prior-art comparison

Synthesised from source reads of cline, continue, aider, vscode-copilot-chat.

| Aspect              | aider                    | cline                                       | continue                                | vscode-copilot-chat                      |
| ------------------- | ------------------------ | ------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| Baseline            | git commit per turn      | in-memory string + URI-encoded virtual doc  | reconstructed from `same+old` lines     | explicit snapshot in `workingCopies.ts`  |
| Edits land in       | working tree (real)      | real disk file (right pane of diff editor)  | real buffer in-place                    | shadow model, host-aggregated WorkspaceEdit |
| Render              | none (just `git diff`)   | side-by-side diff editor + decorations      | inline: green real, red ghost-text      | inline zone widget over live editor      |
| Per-hunk            | no — whole-turn `/undo`  | no — whole-file save/reject                 | yes — `alt+cmd+y/n` + CodeLens          | yes — gutter accept/reject               |
| User edits during   | undetected mid-turn      | reconcile-via-patch at save                 | not locked; line-index drift            | hunk-anchor rebase; drop on miss         |
| Reject              | `/undo` soft-reset       | replay snapshot to buffer                   | delete green + re-insert stored red     | restore from baseline snapshot           |
| Multi-file          | one commit               | one diff editor at a time                   | concurrent `Map<uri, handler>`          | file-tree + multi-diff editor            |
| New file            | eager empty commit       | eager empty file on disk                    | new handler                             | TextEdit against empty doc               |

What 0x0 takes from each:

- **aider**: git-checkpoint baseline; auto-pickup of user dirty state at turn
  start.
- **cline**: reconcile-via-patch when user edited a file the agent wants to
  write; `userEdits` patch fed back to model.
- **continue**: per-hunk `<C-y>`/`<C-n>` UX; multi-file concurrent overlays via
  per-buffer state.
- **vscode-copilot-chat**: hunk-anchor rebase when user edits during stream;
  multi-file → list, not N inline widgets.
