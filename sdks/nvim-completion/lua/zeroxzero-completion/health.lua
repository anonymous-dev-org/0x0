local M = {}

function M.check()
  vim.health.start("zeroxzero-completion")

  -- Check Neovim version
  if vim.fn.has("nvim-0.10") == 1 then
    vim.health.ok("Neovim >= 0.10")
  else
    vim.health.error("Neovim >= 0.10 required")
  end

  -- Check curl
  if vim.fn.executable("curl") == 1 then
    vim.health.ok("curl found in PATH")
  else
    vim.health.error("curl not found in PATH")
  end

  -- Check zeroxzero plugin is installed
  local ok, zxz_config = pcall(require, "zeroxzero.config")
  if ok then
    vim.health.ok("zeroxzero plugin loaded")
    vim.health.info("Server: " .. zxz_config.current.hostname .. ":" .. zxz_config.current.port)
  else
    vim.health.error("zeroxzero plugin not found — install it first")
    return
  end

  -- Check server connectivity
  local zxz_api = require("zeroxzero.api")
  local err, resp = zxz_api.request_sync("GET", "/app", { timeout = 2 })
  if not err and resp and resp.status == 200 then
    vim.health.ok("0x0 server is reachable")
  else
    vim.health.warn("0x0 server not reachable (is it running?)")
  end

  -- Info
  local config = require("zeroxzero-completion.config")
  vim.health.info("Model: " .. config.current.model)
  vim.health.info("Debounce: " .. config.current.debounce_ms .. "ms")
end

return M
