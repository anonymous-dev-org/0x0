local config = require("zeroxzero-completion.config")
local context = require("zeroxzero-completion.context")
local api = require("zeroxzero-completion.api")
local ghost = require("zeroxzero-completion.ghost")
local cache = require("zeroxzero-completion.cache")
local debounce = require("zeroxzero-completion.debounce")

local M = {}

---@type boolean
M._enabled = true
---@type zeroxzero_completion.Request?
M._current_request = nil
---@type fun()?
M._trigger = nil
---@type fun()?
M._cancel_debounce = nil
---@type number?
M._augroup = nil

---Cancel any in-flight request and clear ghost text
local function cancel_all()
  if M._cancel_debounce then
    M._cancel_debounce()
  end
  api.cancel(M._current_request)
  M._current_request = nil
  ghost.clear()
end

---Request a completion for the current cursor position
local function request_completion()
  if not M._enabled then
    return
  end

  -- Must be in insert mode
  if vim.fn.mode() ~= "i" then
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()

  -- Check buffer is modifiable
  if not vim.bo[bufnr].modifiable then
    return
  end

  -- Check filetype
  local ft = vim.bo[bufnr].filetype
  if config.current.disabled_filetypes[ft] then
    return
  end

  local ctx = context.get_context()
  if not ctx then
    return
  end

  -- Check cache first
  local cache_key = ctx.prefix .. "\0" .. ctx.suffix
  local cached = cache.get(cache_key)
  if cached then
    ghost.show(cached)
    return
  end

  -- Cancel previous request
  api.cancel(M._current_request)

  local accumulated = ""

  M._current_request = api.stream(ctx, function(delta, _request_id)
    accumulated = accumulated .. delta
    ghost.append(delta)
  end, function(_request_id)
    -- On done: cache the result
    if accumulated ~= "" then
      cache.set(cache_key, accumulated)
    end
    M._current_request = nil
  end, function(_err, _request_id)
    M._current_request = nil
  end)
end

---Accept the current ghost text
---@return boolean
function M.accept()
  return ghost.accept()
end

---Accept just the first word
---@return boolean
function M.accept_word()
  return ghost.accept_word()
end

---Accept just the first line
---@return boolean
function M.accept_line()
  return ghost.accept_line()
end

---Dismiss the current ghost text
function M.dismiss()
  cancel_all()
end

---Toggle completions on/off
function M.toggle()
  M._enabled = not M._enabled
  if not M._enabled then
    cancel_all()
  end
  vim.notify(
    "0x0 completion: " .. (M._enabled and "enabled" or "disabled"),
    vim.log.levels.INFO
  )
end

---Set up autocmd triggers
function M.setup_triggers()
  cache.setup(config.current.cache_size)

  M._trigger, M._cancel_debounce = debounce.create(request_completion, config.current.debounce_ms)

  M._augroup = vim.api.nvim_create_augroup("zeroxzero_completion", { clear = true })

  vim.api.nvim_create_autocmd("TextChangedI", {
    group = M._augroup,
    callback = function()
      ghost.clear()
      if M._enabled then
        api.cancel(M._current_request)
        M._current_request = nil
        M._trigger()
      end
    end,
  })

  vim.api.nvim_create_autocmd({ "InsertLeave", "BufLeave" }, {
    group = M._augroup,
    callback = function()
      cancel_all()
    end,
  })

  vim.api.nvim_create_autocmd("CursorMovedI", {
    group = M._augroup,
    callback = function()
      if ghost.is_visible() then
        local cursor = vim.api.nvim_win_get_cursor(0)
        local row = cursor[1] - 1
        local col = cursor[2]
        if row ~= ghost._row or col ~= ghost._col then
          cancel_all()
        end
      end
    end,
  })
end

return M
