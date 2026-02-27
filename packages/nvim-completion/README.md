# 0x0-completion.nvim

Inline ghost text code suggestions powered by Claude, similar to GitHub Copilot or Supermaven.

Routes completions through the [0x0](https://github.com/anonymous-dev-org/0x0) server, which calls the Anthropic API on your behalf. Uses `claude-haiku-4-5-20251001` by default for fast time-to-first-token (~200-400ms).

## Requirements

- Neovim >= 0.10
- `curl` in PATH
- [0x0.nvim](https://github.com/anonymous-dev-org/0x0.nvim) plugin installed and configured
- `ANTHROPIC_API_KEY` environment variable (or configured in 0x0 config)

## Installation

### lazy.nvim

```lua
{
  "anonymous-dev-org/0x0-completion.nvim",
  dependencies = { "0x0.nvim" },
  event = "InsertEnter",
  opts = {},
}
```

### packer.nvim

```lua
use {
  "anonymous-dev-org/0x0-completion.nvim",
  requires = { "anonymous-dev-org/0x0.nvim" },
  config = function()
    require("zeroxzero-completion").setup()
  end,
}
```

## Configuration

```lua
require("zeroxzero-completion").setup({
  model = "claude-haiku-4-5-20251001",       -- model for completions
  max_tokens = 256,                          -- max completion length
  debounce_ms = 150,                         -- wait before requesting
  max_prefix_lines = 100,                    -- context before cursor
  max_suffix_lines = 50,                     -- context after cursor
  cache_size = 64,                           -- LRU cache entries
  disabled_filetypes = {                     -- skip these filetypes
    TelescopePrompt = true,
    NvimTree = true,
    lazy = true,
    mason = true,
    help = true,
    [""] = true,
  },
  keymaps = {
    accept = "<Tab>",                        -- accept full completion
    dismiss = "<C-]>",                       -- dismiss ghost text
    accept_word = "<M-w>",                   -- accept first word
    accept_line = "<M-l>",                   -- accept first line
    toggle = "<M-Bslash>",                   -- toggle on/off (normal mode)
  },
})
```

## Keymaps

| Keymap | Mode | Action |
|--------|------|--------|
| `<Tab>` | i | Accept the full completion (falls through when no ghost text) |
| `<C-]>` | i | Dismiss the current ghost text |
| `<M-w>` | i | Accept the first word |
| `<M-l>` | i | Accept the first line |
| `<M-\>` | n | Toggle completions on/off |

All keymaps are configurable via the `keymaps` option in setup().

## Commands

| Command | Description |
|---------|-------------|
| `:ZeroCompletionToggle` | Toggle autocompletion on or off |
| `:ZeroCompletionClear` | Clear the current ghost text |

## Health Check

```vim
:checkhealth zeroxzero-completion
```
