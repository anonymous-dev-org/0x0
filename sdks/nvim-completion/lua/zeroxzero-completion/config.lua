local M = {}

---@class zeroxzero_completion.Config
---@field model string
---@field max_tokens number
---@field debounce_ms number
---@field max_prefix_lines number
---@field max_suffix_lines number
---@field cache_size number
---@field disabled_filetypes table<string, boolean>
---@field keymaps zeroxzero_completion.KeymapConfig

---@class zeroxzero_completion.KeymapConfig
---@field accept string
---@field dismiss string
---@field accept_word string
---@field accept_line string
---@field toggle string

---@type zeroxzero_completion.Config
M.defaults = {
  model = "claude-haiku-4-5-20251001",
  max_tokens = 256,
  debounce_ms = 150,
  max_prefix_lines = 100,
  max_suffix_lines = 50,
  cache_size = 64,
  disabled_filetypes = {
    TelescopePrompt = true,
    NvimTree = true,
    lazy = true,
    mason = true,
    help = true,
    [""] = true,
  },
  keymaps = {
    accept = "<Tab>",
    dismiss = "<C-]>",
    accept_word = "<M-w>",
    accept_line = "<M-l>",
    toggle = "<M-Bslash>",
  },
}

---@type zeroxzero_completion.Config
M.current = vim.deepcopy(M.defaults)

---@param opts? table
function M.setup(opts)
  M.current = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
end

return M
