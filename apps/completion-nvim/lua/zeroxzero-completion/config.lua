--- Configuration for the 0x0-completion plugin.

local M = {}

---@class zeroxzero_completion.Config
---@field model? string
---@field acp zeroxzero_completion.AcpConfig
---@field debounce_ms integer
---@field max_tokens integer
---@field temperature number
---@field keymaps zeroxzero_completion.Keymaps
---@field filetypes zeroxzero_completion.Filetypes
---@field cache zeroxzero_completion.CacheConfig
---@field enabled boolean

---@class zeroxzero_completion.Keymaps
---@field accept string
---@field accept_line string
---@field dismiss string

---@class zeroxzero_completion.Filetypes
---@field exclude string[]

---@class zeroxzero_completion.CacheConfig
---@field enabled boolean
---@field max_entries integer

---@class zeroxzero_completion.AcpConfig
---@field provider string
---@field command string
---@field args string[]
---@field auth_method? string

---@type zeroxzero_completion.Config
M.defaults = {
  model = nil,
  debounce_ms = 150,
  max_tokens = 128,
  temperature = 0,
  enabled = true,
  keymaps = {
    accept = "<Tab>",
    accept_line = "<C-e>",
    dismiss = "<C-]>",
  },
  filetypes = {
    exclude = { "TelescopePrompt", "NvimTree", "help", "qf", "alpha", "dashboard" },
  },
  cache = {
    enabled = true,
    max_entries = 100,
  },
  acp = {
    provider = "codex-acp",
    command = "codex-acp",
    args = { "-c", "notify=[]" },
    auth_method = "chatgpt",
  },
}

---@type zeroxzero_completion.Config
M.current = vim.deepcopy(M.defaults)

--- Apply user configuration.
---@param opts? table
function M.setup(opts)
  if opts then
    M.current = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts)
  end
end

return M
