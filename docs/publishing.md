# Publishing

0x0 is split into one source monorepo plus public install repositories:

- `anonymous-dev-org/0x0`: source monorepo and server releases.
- `anonymous-dev-org/0x0.nvim`: Neovim plugin (chat, inline edit, review, ghost-text completion).
- `anonymous-dev-org/homebrew-tap`: Homebrew formulae for released server binaries.

## App Layout

- `apps/server`: local 0x0 server.
- `apps/0x0.nvim`: single Neovim plugin covering chat, inline edit/ask, run review, repo/LSP context, and inline ghost-text completion.

## Plugin Repository Sync

The `Sync Plugin Repos` workflow copies plugin source from this monorepo into the public plugin repository:

- `apps/0x0.nvim` -> `anonymous-dev-org/0x0.nvim`

The workflow runs after pushes to `main` that touch the plugin, and can also be run manually.

It requires a repository secret named `PLUGIN_SYNC_TOKEN`. The token must be able to push to the plugin repository.

Keep the Lua module name as `zxz` for compatibility unless a breaking release intentionally changes it.

## User Install Shape

Server:

```sh
brew tap anonymous-dev-org/tap
brew install 0x0
0x0 server
```

`0x0 server` is idempotent and starts the local server in the background. Use `0x0 init` once to store `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; the command also prompts on first server start if neither key is configured.

The installed executable and release archive binary are both named `0x0`.

Neovim plugin (chat + completion):

```lua
{
  "anonymous-dev-org/0x0.nvim",
  opts = {
    server_url = "http://localhost:4096",
    -- inline ghost-text completion config
    complete = {
      enabled = true,
      provider = "codex-acp",
    },
  },
}
```
