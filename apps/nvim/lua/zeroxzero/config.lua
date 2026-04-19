--- Configuration for the 0x0 nvim plugin.

local M = {}

---@class zeroxzero.Config
---@field transport "server"|"native"
---@field server_url string
---@field provider? string
---@field model? string
---@field max_turns integer
---@field auto_select "treesitter"|"none"
---@field permission_mode? string
---@field keymaps zeroxzero.Keymaps

---@class zeroxzero.Keymaps
---@field edit string
---@field session string
---@field chat string
---@field add_context string
---@field clear_context string
---@field accept string
---@field reject string
---@field accept_all string
---@field reject_all string
---@field next_hunk string
---@field prev_hunk string
---@field quit string

---@type zeroxzero.Config
M.defaults = {
  transport = "native",
  server_url = "http://localhost:4096",
  provider = nil,
  model = nil,
  max_turns = 5,
  auto_select = "treesitter",
  permission_mode = nil,
  keymaps = {
    edit = "<leader>ze",
    session = "<leader>zs",
    chat = "<leader>zc",
    add_context = "<leader>za",
    clear_context = "<leader>zA",
    accept = "<CR>",
    reject = "cx",
    accept_all = "ca",
    reject_all = "cX",
    next_hunk = "]c",
    prev_hunk = "[c",
    quit = "q",
  },
}

---@type zeroxzero.Config
M.current = vim.deepcopy(M.defaults)

--- Apply user configuration.
---@param opts? table
function M.setup(opts)
  if opts then
    M.current = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts)
  end
end

return M
