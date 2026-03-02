local M = {}

---Create a debounced function
---@param fn function
---@param delay_ms number
---@return fun() trigger, fun() cancel, fun() close
function M.create(fn, delay_ms)
  local timer = vim.uv.new_timer()

  local function trigger()
    timer:stop()
    timer:start(delay_ms, 0, function()
      timer:stop()
      vim.schedule(fn)
    end)
  end

  local function cancel()
    timer:stop()
  end

  local function close()
    timer:stop()
    if not timer:is_closing() then
      timer:close()
    end
  end

  return trigger, cancel, close
end

return M
