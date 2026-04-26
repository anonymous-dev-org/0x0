# 0x0-completion.nvim

Neovim inline ghost-text completion client for the local 0x0 server.

## Install

```lua
{
  "anonymous-dev-org/0x0-completion.nvim",
  opts = {
    server_url = "http://localhost:4096",
  },
}
```

## Default Keymaps

- `<Tab>` accepts the current completion.
- `<C-e>` accepts the first line.
- `<C-]>` dismisses the completion.

## Commands

- `:ZeroCompletionToggle`

## Server

Start the 0x0 server before using the plugin:

```sh
0x0 server
```
