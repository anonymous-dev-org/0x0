# Avante.nvim chat panel UX — extraction & gap analysis

Source: `avante.nvim/lua/avante/` (vendored under repo root). All references below
use that prefix unless stated. Comparison target: `apps/chat-nvim/lua/zeroxzero/`
(the in-house 0x0 chat panel).

This doc catalogs **what** the avante sidebar does, **how** it does it (with
file:line refs), and at the end, the **gaps** between avante and 0x0 so we know
what is worth porting.

---

## 1. Layout & windows

**What.** A multi-pane sidebar with up to five vertically stacked containers in
this order: result (assistant output), selected code, selected files, todos,
input. Layout auto-switches between vertical and horizontal based on window
geometry ("smart" mode). Width/height of the sidebar is configurable; a
full-screen toggle hides every other window in the tab and restores them later.
Each Neovim tab has its own independent sidebar instance.

**How.**
- Container list and order: `lua/avante/sidebar.lua:43-49` (`SIDEBAR_CONTAINERS`).
- Built on `nui.nvim` `NuiSplit` objects, one per container.
- Container builders: result `sidebar.lua:3215-3238`, input `sidebar.lua:2950-3125`,
  selected files `sidebar.lua:3322-3449`, selected code `sidebar.lua:1097-1115` /
  `sidebar.lua:3267`.
- Layout/sizing defaults: `lua/avante/config.lua:692-699`.
- VimResized handling: `sidebar.lua:1613-1627`.
- Full-screen toggle (stores/restores other window sizes): `sidebar.lua:1653-1693`.
- Tab cycling between containers via `<Tab>`/`<S-Tab>`: `sidebar.lua:1565-1611`,
  `config.lua:658-659`.
- Per-tab sidebar registry: `lua/avante/init.lua:411-429`, `init.lua:330-341`
  (TabClosed cleanup), `sidebar.lua:91-126` (`Sidebar:new`).

**0x0 today.** Two-buffer split (transcript + input) with a single tabpage
registry; no selected-files panel, no todos panel, no full-screen toggle, no
container cycling.

---

## 2. Input UX

**What.** A dedicated `AvanteInput` filetype buffer with multiline editing.
Submit on `<CR>` (normal) or `<C-s>` (insert); cancel on `<C-c>`/`<Esc>`/`q`.
Slash commands (`/lines 10-20 question`, `/commit`, …) are parsed and routed.
`@` mentions trigger nvim-cmp completion sources for files, URLs, codebase, etc.
A floating "hint" window under the input shows the active submit binding and
the current spinner. A persistent prompt logger lets users browse previous
prompts via `<C-p>`/`<C-n>`.

**How.**
- Input container build + autocmds: `sidebar.lua:2951-3125`.
- Submit / cancel keymaps: `sidebar.lua:3013-3026`, `config.lua:627-634`.
- Slash-command parsing in submit: `sidebar.lua:2713-2740`.
- nvim-cmp source registration for AvanteInput: `init.lua:566-589`.
- Mention sources: `lua/cmp_avante/` (mentions, files, etc.).
- Submit pipeline: `sidebar.lua:2700-2945` (`handle_submit`).
- Selected-files / selected-code prefixed onto user message:
  `sidebar.lua:1854-1884` (`render_chat_record_prefix`).
- Prompt-history navigation: `sidebar.lua:3015-3026`, `config.lua:577-586`.
- Floating hint window with shortcuts + spinner: `lua/avante/ui/prompt_input.lua:132-177`.

**0x0 today.** Multiline input + `@` file completion + `<CR>`/`<localleader>c`
already work. No slash commands, no nvim-cmp integration, no hint window, no
prompt history navigation, no @-source diversity (URL / codebase / docs).

---

## 3. Streaming output rendering

**What.** Assistant tokens stream into the result buffer with markdown
treesitter parsing, code-block syntax highlighting and filepath headers.
`<think>…</think>` blocks collapse to a "🤔 Thought content:" quote that can
be expanded. Tool-use messages render with status (pending/running/done/failed),
inline tool input/output, and a `<S-Tab>` toggle to expand the captured logs. A
state spinner at the bottom of the result buffer animates with state-specific
highlight groups (generating / tool-calling / thinking / compacting / succeeded
/ failed / cancelled). When the cursor enters a code block, a right-aligned
virtual hint shows `[a: apply]`; when on a user request block, `[r: retry,
e: edit]`.

**How.**
- Throttled re-render (50 ms): `sidebar.lua:1761-1764`.
- Streaming callbacks (`on_messages_add`, `on_tool_log`, …): `sidebar.lua:2790-2821`.
- Markdown / fence transformation, conflict-marker injection:
  `sidebar.lua:337-554` (`transform_result_content`), `sidebar.lua:597-673`
  (`extract_code_snippets_map`).
- Thinking-block collapse: `sidebar.lua:532-554` (`generate_display_content`).
- Spinner / state line: `sidebar.lua:2190-2237` (`render_state`),
  `config.lua:739-740` (spinner glyphs).
- Tool-use expansion UI: `sidebar.lua:1151-1228`.
- Inline hints over code/user blocks: `sidebar.lua:1202-1219`,
  `sidebar.lua:1376-1428`, `sidebar.lua:1232-1261` (codeblock jump).

**0x0 today.** Append-only chunk rendering with extmark-based in-place patching
(`chat_widget.lua:381-521`), a 120 ms activity spinner with 10-frame cycle
(`chat_widget.lua:290-301`), and tool-call status icons (✓ · ⠋ ✗) on a single
line. Missing: markdown/treesitter rendering, code-block syntax highlighting,
filepath headers, collapsible thinking blocks, expandable tool logs, contextual
inline hints over code/user blocks.

---

## 4. Diff / patch / edit UX

**What.** When the user triggers apply, avante inserts conflict markers
(`<<<<<<< HEAD` / `=======` / `>>>>>>> Snippet`) into the target buffer and
highlights the two sides with `AvanteConflictCurrent` / `AvanteConflictIncoming`.
Hunks are navigated with `]x`/`[x` and resolved with `co`/`ct`/`cb`/`cc`
(ours / theirs / both / cursor). A `minimize_diff` option computes a minimal
patch so untouched lines never enter the conflict view.

**How.**
- Apply pipeline: `sidebar.lua:909-967` (`apply`),
  `sidebar.lua:675-715` (`insert_conflict_contents`).
- Conflict highlighting: `lua/avante/diff.lua:129-174`.
- Conflict navigation/resolution mappings: `config.lua:608-616`.
- Minimal patch computation: `sidebar.lua:850-868` (`minimize_snippets`),
  invoked at `sidebar.lua:935`.

**0x0 today.** Completely different model: a git **shadow worktree**
(`shadow_worktree.lua:64-359`) materializes proposed edits, and review goes
through `diffview.nvim` in a new tab (`diff_preview.lua:55-85`). Accept/discard
operate on whole files or patches via `git apply`
(`shadow_worktree.lua:197-310`, `:637-646`). No in-buffer conflict markers, no
hunk-by-hunk keymaps inside the chat panel itself.

---

## 5. History / sessions

**What.** Each chat is a `ChatHistory` table containing entries, messages,
auto-generated title, todos, compaction memory, ACP session id and token usage.
Persisted to `~/.local/state/avante/{bufnr}.json`, debounced 1000 ms after each
message. `Sidebar:new_chat()` clears state for a fresh thread; a history picker
lets users switch threads.

**How.**
- History storage and (de)serialization: `lua/avante/history/`, `lua/avante/path.lua`.
- New-chat / compact-history: `sidebar.lua:2273-2288`, `sidebar.lua:2252-2271`.
- Debounced save: `sidebar.lua:2290-2295`.
- Auto-generated title from first assistant message: `sidebar.lua:2350-2362`.
- History picker entry point: `lua/avante/api.lua` (`select_history`).

**0x0 today.** In-memory only (`history.lua:37-46`); `:ZeroChatNew` resets the
session (`chat.lua:452-457`); no disk persistence, no history picker, no
compaction memory.

---

## 6. Selection / context features

**What.** A `FileSelector` manages the list of files attached to the prompt;
they appear in the selected-files container with icon + relative path, added
with `@` and removed with `d`. If the sidebar is opened from a visual
selection, the selected code (range, filepath, content, filetype) shows in the
selected-code container with syntax highlighting inherited from the source
buffer. Both are serialized into the prompt prefix sent to the model
(datetime, provider/model, attached filepaths, inline code block).

**How.**
- File selector implementation: `lua/avante/file_selector.lua`.
- Selected-files container UI + keymaps: `sidebar.lua:3322-3449` (especially
  `:3417-3440` for `@` add and `d` remove).
- Selected-code container: `sidebar.lua:1097-1115`, `sidebar.lua:3267`.
- Prompt prefix composition: `sidebar.lua:1854-1884`.
- Repo map: `lua/avante/repo_map.lua` (codebase context source).

**0x0 today.** Context is **only** via inline `@mentions` parsed from the
input buffer (`reference_mentions.lua:99-132`, `file_completion.lua`); no
persistent selected-files panel, no visual-selection capture, no repo-map, no
explicit prefix metadata in the request.

---

## 7. Keymaps & user commands

**Sidebar (result) buffer.**
- `q` / `<Esc>` / `<C-c>` — close sidebar.
- `x` — toggle full-screen.
- `a` — apply code block under cursor; `A` — apply all.
- `r` — retry current user request; `e` — edit it.
- `<Tab>` / `<S-Tab>` — cycle container focus / expand-collapse tool use.
- `]p` / `[p` — jump to next/prev user prompt.
- `]x` / `[x` — jump to next/prev conflict (when in diff state).

Implementations: `sidebar.lua:1117-1185`, `sidebar.lua:1230-1320`,
`config.lua:650-670`.

**Input buffer.** `<CR>`/`<C-s>` submit, `<C-p>`/`<C-n>` prompt history,
`<C-c>` cancel, `x` full-screen, `<Tab>`/`<S-Tab>` switch focus
(`sidebar.lua:3013-3052`, `config.lua:577-586`).

**Selected files.** `d` remove, `@` add, `<Tab>`/`<S-Tab>` switch focus
(`sidebar.lua:3420-3440`).

**Top-level commands.** `:AvanteAsk [query]`, `:AvanteChat`, `:AvanteEdit`,
`:AvanteRefresh`, `:AvanteFocus`, `:AvanteToggle`, `:AvanteSelectModel`,
`:AvanteSelectHistory` (`init.lua:89-226`, `lua/avante/api.lua`).

**Confirm dialog.** `y/Y` yes, `a/A` all-yes, `n/N` no, arrows / `<Tab>` cycle
buttons, `<CR>` activate, `c`/`r`/`i` focus code/response/input
(`lua/avante/ui/confirm.lua:225-295`, `config.lua:679-684`).

**0x0 today.** `:ZeroChat`, `:ZeroChatNew`, `:ZeroChatSubmit`,
`:ZeroChatCancel`, `:ZeroChatReview`, `:ZeroChatAcceptAll`,
`:ZeroChatDiscardAll`, `:ZeroChatStop`, `:ZeroChatSettings`. Input keymaps:
`<CR>` submit, `<localleader>c` cancel, `<localleader>d` review, `@` complete.
Transcript keymaps: `a`/`A`/`r`/`R` only when a permission prompt is live
(`chat_widget.lua:532-575`).

---

## 8. Highlights & visual polish

**What.** ~40 custom highlight groups: gradient header titles
(`AvanteTitle`/`Subtitle`/`ThirdTitle`), state-specific spinner colors,
conflict halves, button hover/default states, a 14-shade ASCII-logo gradient
(`AvanteLogoLine1..14`), and sidebar-specific `Normal`/`WinSeparator` overrides.
Each container's title sits in a `winbar` with embedded `%#Highlight#` markers.
Borders are minimal (NuiSplit), with the code-window separator tinted to blend
into `NormalFloat`. Spinners use `virt_lines`, hints use right-aligned
`virt_text`.

**How.**
- Highlight definitions: `lua/avante/highlights.lua:1-174`,
  `config.lua:596-600` (override hook).
- Header / winbar rendering: `sidebar.lua:997-1051`, `sidebar.lua:1053-1115`.
- Window options & separator handling: `sidebar.lua:975-995`,
  `sidebar.lua:217-248`.
- Extmark namespaces for hints/spinner/state:
  `sidebar.lua:1202-1219`, `sidebar.lua:2231-2235`,
  `lua/avante/ui/line.lua` (line + highlight builder).
- Logo render at fresh-chat start: `sidebar.lua:1629-1651`,
  `lua/avante/utils/logo.lua`.

**0x0 today.** Default `markdown` filetype on the transcript, status icons in
plain text, no custom highlight groups, no winbar header, no logo screen.

---

## Gap summary (priority for closing the gap)

The cheap, high-impact wins first.

1. **Markdown / treesitter rendering of the transcript.** Single biggest visual
   gap. Run `vim.treesitter.start(buf, "markdown")` and inject embedded
   languages on fenced blocks. Reference: `sidebar.lua:337-554`.
2. **Container header / winbar with model name + state.** Cheap and signals
   "what's running right now". Reference: `sidebar.lua:997-1051`.
3. **Floating shortcut/hint window under input.** Removes the need to memorize
   keys. Reference: `lua/avante/ui/prompt_input.lua:132-177`.
4. **Persistent disk history + history picker.** Today every `:ZeroChatNew`
   loses the thread. Reference: `lua/avante/history/`, `sidebar.lua:2273-2295`.
5. **Selected-files panel as a first-class container** instead of inline-only
   `@mentions`. Adds visibility of attached context and explicit `d`/`@`
   keymaps. Reference: `sidebar.lua:3322-3449`.
6. **Visual-selection capture** (`:'<,'>ZeroChatAsk` style) wired into the
   prompt prefix. Reference: `sidebar.lua:1097-1115`,
   `sidebar.lua:1854-1884`.
7. **Slash-command dispatch** in the input buffer (`/commit`, `/lines`, custom
   skills). Reference: `sidebar.lua:2713-2740`.
8. **Collapsible thinking blocks + expandable tool-use logs.** Today thoughts
   render as a flat header; tool calls collapse to one line with no log.
   Reference: `sidebar.lua:532-554`, `sidebar.lua:1151-1228`.
9. **Inline contextual hints** (`[a: apply]`, `[r: retry, e: edit]`) when the
   cursor is over code/user blocks. Reference: `sidebar.lua:1202-1219`,
   `sidebar.lua:1376-1428`.
10. **Prompt-history navigation** (`<C-p>`/`<C-n>` in input). Reference:
    `sidebar.lua:3015-3026`.
11. **Full-screen toggle** for the sidebar. Reference:
    `sidebar.lua:1653-1693`.
12. **Custom highlight groups + state-specific spinner colors.** Reference:
    `lua/avante/highlights.lua`, `sidebar.lua:2190-2237`.

Things 0x0 already does well and shouldn't regress when porting:
- Shadow-worktree review flow (more robust than avante's in-buffer conflict
  markers for multi-file edits).
- Per-tab session registry with clean teardown.
- Queued-prompt handling while a turn is in flight.
- Keyboard-driven permission prompts inline in the transcript.
