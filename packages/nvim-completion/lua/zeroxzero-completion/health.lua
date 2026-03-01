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

  -- Show resolved server URL
  local config = require("zeroxzero-completion.config")
  local env_url = os.getenv("ZEROXZERO_SERVER_URL")
  if env_url and env_url ~= "" then
    vim.health.ok("Server URL from ZEROXZERO_SERVER_URL: " .. env_url)
  elseif config.current.server_url then
    vim.health.ok("Server URL from setup() config: " .. config.current.server_url)
  else
    vim.health.info("Server URL: http://127.0.0.1:4096 (default)")
  end

  -- Check server connectivity via /global/health
  local url = env_url or config.current.server_url or "http://127.0.0.1:4096"
  local health_url = url .. "/global/health"
  local result = vim.system({ "curl", "--silent", "--max-time", "2", "-o", "/dev/null", "-w", "%{http_code}", health_url }, { text = true }):wait()
  if result.code == 0 and result.stdout and result.stdout:match("^2") then
    vim.health.ok("0x0 server is reachable at " .. url)
  else
    vim.health.warn("0x0 server not reachable at " .. url .. " (is it running?)")
  end

  -- Info
  vim.health.info("Model: " .. config.current.model)
  vim.health.info("Debounce: " .. config.current.debounce_ms .. "ms")
end

return M
