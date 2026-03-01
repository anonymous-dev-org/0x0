local config = require("zeroxzero-completion.config")

local M = {}

---@type number
local next_request_id = 0

---@class zeroxzero_completion.Request
---@field id number
---@field process vim.SystemObj?

---Get the 0x0 server URL base.
---Priority: env var > plugin config > 0x0.nvim config > default
---@return string
local function get_server_url()
  -- 1. Env var (any plugin/tool can set this)
  local env_url = os.getenv("ZEROXZERO_SERVER_URL")
  if env_url and env_url ~= "" then
    return env_url
  end
  -- 2. Plugin setup() config
  if config.current.server_url then
    return config.current.server_url
  end
  -- 3. Read from 0x0.nvim plugin (shares the running server's host/port)
  local ok, nvim_config = pcall(require, "zeroxzero.config")
  if ok and nvim_config.current and nvim_config.current.port > 0 then
    return string.format("http://%s:%d", nvim_config.current.hostname, nvim_config.current.port)
  end
  -- 4. Default
  return "http://127.0.0.1:4096"
end

---Stream a completion from the 0x0 server
---@param ctx zeroxzero_completion.Context
---@param on_delta fun(text: string, request_id: number)
---@param on_done fun(request_id: number)
---@param on_error fun(err: string, request_id: number)
---@return zeroxzero_completion.Request
function M.stream(ctx, on_delta, on_done, on_error)
  next_request_id = next_request_id + 1
  local request_id = next_request_id

  local base_url = get_server_url()
  local cfg = config.current

  local body = vim.json.encode({
    prefix = ctx.prefix,
    suffix = ctx.suffix,
    language = ctx.language,
    filename = ctx.filename,
    model = cfg.model,
    max_tokens = cfg.max_tokens,
  })

  local url = base_url .. "/completion"

  local cmd = {
    "curl",
    "--silent",
    "--no-buffer",
    "--max-time", "10",
    "-H", "Content-Type: application/json",
    "-H", "x-zeroxzero-directory: " .. vim.fn.getcwd(),
    "-d", body,
    url,
  }

  -- Add basic auth if configured
  local auth = config.current.auth
  if auth then
    table.insert(cmd, 5, "-u")
    table.insert(cmd, 6, auth.username .. ":" .. auth.password)
  end

  local buffer = ""

  local process = vim.system(cmd, {
    text = true,
    stdout = function(_, data)
      if not data then
        return
      end

      vim.schedule(function()
        -- Stale request check
        if request_id ~= next_request_id then
          return
        end

        buffer = buffer .. data

        while true do
          local newline_pos = buffer:find("\n")
          if not newline_pos then
            break
          end

          local line = buffer:sub(1, newline_pos - 1)
          buffer = buffer:sub(newline_pos + 1)

          -- SSE format: "data: {...}"
          if line:sub(1, 5) == "data:" then
            local json_str = vim.trim(line:sub(6))
            local parse_ok, parsed = pcall(vim.json.decode, json_str)
            if parse_ok and parsed then
              if parsed.type == "delta" and parsed.text then
                on_delta(parsed.text, request_id)
              elseif parsed.type == "error" then
                on_error(parsed.error or "Server error", request_id)
              end
              -- "done" type is handled by process exit
            end
          end
        end
      end)
    end,
  }, function(result)
    vim.schedule(function()
      if request_id ~= next_request_id then
        return
      end

      if result.code ~= 0 and result.code ~= 28 then
        local stderr = result.stderr or ""
        if stderr ~= "" then
          on_error("curl error (exit " .. result.code .. "): " .. stderr, request_id)
          return
        end
      end

      on_done(request_id)
    end)
  end)

  return { id = request_id, process = process }
end

---Cancel an in-flight request
---@param request zeroxzero_completion.Request?
function M.cancel(request)
  if request and request.process then
    request.process:kill("sigterm")
    request.process = nil
  end
end

---@return number
function M.current_request_id()
  return next_request_id
end

return M
