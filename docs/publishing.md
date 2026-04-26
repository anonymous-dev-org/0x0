# Publishing

0x0 is split into one source monorepo plus public install repositories:

- `anonymous-dev-org/0x0`: source monorepo and server releases.
- `anonymous-dev-org/0x0-chat.nvim`: Neovim chat, inline edit, and review plugin.
- `anonymous-dev-org/0x0-completion.nvim`: Neovim ghost-text completion plugin.
- `anonymous-dev-org/homebrew-tap`: Homebrew formulae for released server binaries.

## App Layout

- `apps/server`: local 0x0 server.
- `apps/chat-nvim`: chat, inline edit, and review Neovim plugin.
- `apps/completion-nvim`: inline ghost-text completion Neovim plugin.

## Plugin Repository Sync

The `Sync Plugin Repos` workflow copies plugin source from this monorepo into the public plugin repositories:

- `apps/chat-nvim` -> `anonymous-dev-org/0x0-chat.nvim`
- `apps/completion-nvim` -> `anonymous-dev-org/0x0-completion.nvim`

The workflow runs after pushes to `main` that touch either plugin, and can also be run manually.

It requires a repository secret named `PLUGIN_SYNC_TOKEN`. The token must be able to push to both plugin repositories.

Keep the Lua module name as `zeroxzero` for compatibility unless a breaking release intentionally changes it.

## User Install Shape

Server:

```sh
brew tap anonymous-dev-org/tap
brew install 0x0
0x0 server
```

The tap may keep the backing formula as `zeroxzero-server`, but `0x0` is the public Homebrew alias and installed executable.

Chat plugin:

```lua
{
  "anonymous-dev-org/0x0-chat.nvim",
  opts = {
    server_url = "http://localhost:4096",
  },
}
```

Completion plugin:

```lua
{
  "anonymous-dev-org/0x0-completion.nvim",
  opts = {
    server_url = "http://localhost:4096",
  },
}
```
