local M = {}

---@class zeroxzero.ProviderConfig
---@field name string
---@field command string
---@field args? string[]
---@field env? table<string, string>

---@class zeroxzero.Config
---@field provider string
---@field providers table<string, zeroxzero.ProviderConfig>

---@type zeroxzero.Config
M.defaults = {
  provider = "claude-acp",
  providers = {
    ["claude-acp"] = {
      name = "Claude ACP",
      command = "claude-code-acp",
    },
    ["claude-agent-acp"] = {
      name = "Claude Agent ACP",
      command = "claude-agent-acp",
    },
    ["codex-acp"] = {
      name = "Codex ACP",
      command = "codex-acp",
    },
    ["gemini-acp"] = {
      name = "Gemini ACP",
      command = "gemini",
      args = { "--acp" },
    },
  },
}

M.current = vim.deepcopy(M.defaults)

---@param opts? table
function M.setup(opts)
  M.current = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
end

---@param name? string
---@return zeroxzero.ProviderConfig|nil, string|nil
function M.resolve_provider(name)
  name = name or M.current.provider
  local provider = M.current.providers[name]
  if not provider then
    return nil, "unknown provider: " .. tostring(name)
  end
  return provider, nil
end

return M
