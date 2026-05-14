# 0x0.nvim — Architecture

`apps/0x0.nvim` is the monolithic Neovim plugin for the 0x0 stack. It
covers chat, inline edit/ask, code actions, run lifecycle, multi-file
review, repo/LSP context, and inline ghost-text completion. There is no
separate completion plugin — completion is folded in under
`lua/zxz/complete/`.

## Module layout

```
apps/0x0.nvim/
├── plugin/0x0.lua                       # guard + require("zxz").setup()
└── lua/zxz/
    ├── init.lua                         # M.setup(opts) — registers every Zxz* command
    ├── core/                            # cross-cutting plumbing (no UI)
    │   ├── acp_client.lua               # ACP client + M.stream_completion helper
    │   ├── acp_transport.lua            # subprocess + idle watchdog
    │   ├── checkpoint.lua               # git snapshot primitive (refs/0x0/checkpoints/)
    │   ├── chat_db.lua                  # SQLite-backed chat/message/run store
    │   ├── config.lua                   # merged schema (config.current.*, config.current.complete.*)
    │   ├── events.lua                   # tiny on/off/emit pub-sub
    │   ├── history.lua                  # in-memory message buffer
    │   ├── history_store.lua            # chat_db compatibility wrapper
    │   ├── log.lua                      # rotating debug log (uses paths)
    │   ├── notify.lua                   # bell/notification helper
    │   ├── paths.lua                    # state_dir/chat_db_path/log_path + migrate_legacy
    │   ├── reconcile.lua                # agent-view vs disk conflict detection
    │   ├── run_registry.lua             # detached autonomous runs
    │   ├── runs_store.lua               # chat_db compatibility wrapper for runs
    │   └── settings.lua                 # provider/model/mode picker
    ├── chat/                            # chat thread UI + mixins
    │   ├── chat.lua                     # orchestrator; mixes the modules below
    │   ├── runtime.lua                  # in-process live chat registry
    │   ├── widget.lua                   # tab-split input/transcript UI
    │   ├── line.lua                     # render primitive
    │   ├── session.lua / turn.lua       # ACP session + turn lifecycle
    │   ├── permissions.lua + tool_policy.lua
    │   ├── fs_bridge.lua                # host fs_read/fs_write through reconcile
    │   ├── persistence.lua              # history save/load
    │   ├── checkpoints.lua              # per-turn snapshot lifecycle
    │   ├── runs.lua / run_review.lua / run_actions.lua / run_timeline.lua
    │   ├── ephemeral.lua                # one-shot session (used by inline_ask)
    │   ├── title.lua                    # auto-title threads
    │   └── util.lua
    ├── edit/                            # buffer-local edit surfaces
    │   ├── inline_diff.lua              # hunk overlay + accept/reject keymaps
    │   ├── inline_edit.lua              # scope-aware buffer edit
    │   ├── inline_ask.lua               # read-only inline question
    │   └── code_actions.lua             # vim.ui.select code-action menu
    ├── complete/                        # inline ghost-text completion
    │   ├── init.lua                     # orchestrator (autocmds + keymaps)
    │   ├── ghost.lua                    # virt-text rendering
    │   ├── context.lua                  # prefix/suffix gather
    │   ├── cache.lua                    # LRU + telemetry
    │   └── debounce.lua
    └── context/                         # cross-feature context providers
        ├── repo_map.lua                 # treesitter symbol digest
        ├── lsp.lua                      # hover/definition/diagnostics
        ├── recent.lua                   # recent-files ring
        ├── auto_prelude.lua             # invisible context block
        ├── test_command.lua             # @test-output detection
        ├── reference_mentions.lua       # @file/@selection/@symbol parser
        ├── mention_highlight.lua        # live mention hl in chat input
        └── file_completion.lua          # @file completion menu
```

## Namespaces

- Lua require: `zxz.<subdir>.<module>` (e.g. `require("zxz.core.acp_client")`).
- User commands: `Zxz*` (29 commands; see `:command Zxz<Tab>`).
- Highlight groups: `Zxz*`.
- Augroups + extmark namespaces: `zxz_*`.
- Filetypes: `zxz-chat-input`, `zxz-chat-files`, `zxz-inline-edit-input`,
  `zxz-inline-ask-input`.
- Git refs: `refs/0x0/checkpoints/<turn_id>`.

## State paths

All disk state lives under `stdpath('state') .. "/0x0/"`:

| Path                              | Purpose                            |
|-----------------------------------|------------------------------------|
| `0x0/chat.sqlite`                 | chats, messages, queues, permissions, tool calls, and run records |
| `0x0/debug.log`                   | rotating log (5 MB)                |
| `0x0/complete/telemetry.jsonl`    | completion accept/dismiss telemetry|

`core/paths.migrate_legacy()` runs once at `setup()` and renames
`stdpath('state') .. "/zeroxzero"` to `…/0x0` if the new path is empty.
Idempotent; no-ops on second launch.

## ACP wiring

Two flavors of ACP session share one `core/acp_client`:

- **Chat / inline edit / run_registry** — full interactive client. Owns
  permission UI, fs/read_text_file + fs/write_text_file bridge, and a
  long-lived session per chat thread. No `authenticate` call (chat
  providers don't need it).
- **Inline completion** — lightweight wrapper at
  `acp_client.stream_completion(provider, request, on_chunk, on_done)`.
  Maintains a per-provider singleton client, calls `authenticate` once
  per client when `provider.auth_method` is set (e.g. `codex-acp` with
  `chatgpt` auth), and keeps sessions read-only: no host fs bridge, no
  write/shell/edit permission approval, and cancellation drops pending
  prompt callbacks so late chunks cannot repaint ghost text.

Chat sessions and completion sessions do **not** share a process —
completion's client is keyed by `provider.command + args` and runs
independently so a fast/cheap completion model can coexist with the
chat model.

## Config shape

`require("zxz").setup(opts)` deep-extends defaults with `opts`. Top-level
keys: `provider`, `width`, `input_height`, `request_timeout_ms`,
`idle_kill_ms`, `tool_policy`, `repo_map`, `auto_prelude`, `code_actions`,
`detached_runs_max`, `providers`, `complete`.

`complete` is its own block (`enabled`, `provider`, `model`,
`debounce_ms`, `max_tokens`, `temperature`, `keymaps`,
`filetypes.exclude`, `cache`, `telemetry`). `complete.provider` resolves
through the shared `providers` table and is distinct from the chat
`provider`, so completion can target a different provider / model than
chat. Advanced setups can use `complete.acp = { command, args,
auth_method }` as an explicit command override.

## Events

`core/events` exposes `on(event, fn)`, `off(event, fn)`, `emit(event, ...)`.
The chat store emits `zxz_chat_updated` after DB writes; the visible chat
panel subscribes to the selected chat id so reopening a background chat can
reload accumulated DB rows and keep tailing live updates.

`chat/runtime.lua` owns live in-process chat objects and the active chat per
tab. The DB remains the durable source of truth; runtime is only the manager for
currently running agents, cancellation, stop, and headless submit dispatch.

## Runtime dependency

Chat persistence uses the `sqlite3` executable. Missing SQLite does not break
startup, but chat persistence logs a clear error and chat history/run listing
will be unavailable until `sqlite3` is installed.

## What this plugin explicitly does **not** ship

- Debug adapter UX (use `nvim-dap` + `nvim-dap-ui`).
- Remote dev / devcontainer integration (use `distant.nvim`).
- Multiplayer collaboration / call / livekit.
- Background edit-prediction model training (Zeta-style).
- A separate completion plugin — completion is part of 0x0.nvim now.
