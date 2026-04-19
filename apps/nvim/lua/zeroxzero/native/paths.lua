--- Shared filesystem paths for native Neovim transports.

local M = {}

local function ensure_dir(path)
  vim.fn.mkdir(path, "p")
  return path
end

function M.state_dir()
  return ensure_dir(vim.fn.stdpath("state") .. "/zeroxzero")
end

function M.session_registry_path()
  return M.state_dir() .. "/sessions.json"
end

function M.nvim_state_path()
  return M.state_dir() .. "/nvim-bridge-state.json"
end

function M.claude_mcp_config_path()
  return M.state_dir() .. "/claude-mcp.json"
end

function M.plugin_root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(source, ":p:h:h:h:h")
end

function M.nvim_mcp_server_path()
  return M.plugin_root() .. "/apps/server/src/mcp/nvim-server.ts"
end

return M
