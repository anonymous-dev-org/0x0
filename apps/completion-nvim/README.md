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

- `:ZeroCompletionSettings`

`ZeroCompletionSettings` opens a small selector for:

- enabled/disabled
- provider and model
- effort
- max tokens
- temperature

## Server

Initialize provider keys once, then start the local background server:

```sh
0x0 init
0x0 server
```
