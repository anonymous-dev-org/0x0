--- Shared active-session and queued-context state for chat and inline edit.

local config = require("zeroxzero.config")
local transport = require("zeroxzero.transport")
local util = require("zeroxzero.util")

local M = {}

---@class zeroxzero.ActiveSession
---@field id? string
---@field provider string
---@field label string

---@class zeroxzero.ContextItem
---@field kind "file"|"selection"
---@field filepath string
---@field filetype string
---@field label string
---@field lines string[]
---@field start_line? integer
---@field end_line? integer

---@type zeroxzero.ActiveSession?
local _active = nil

---@type zeroxzero.ContextItem[]
local _context = {}

local function format_session_label(session)
  if session.label and session.label ~= "" then
    return session.label
  end

  if session.status then
    return string.format("[%s] %s · %s · %s", session.provider, session.id:sub(1, 8), session.status, session.last_active_at or "")
  end

  return string.format("[%s] %s · %s", session.provider, session.id:sub(1, 8), session.last_active_at or "")
end

local function provider_name(provider)
  return provider.name or provider.id
end

---@param item zeroxzero.ContextItem
local function add_context_item(item)
  for _, existing in ipairs(_context) do
    if existing.label == item.label then
      vim.notify("0x0: Context already queued: " .. item.label, vim.log.levels.INFO)
      return
    end
  end

  table.insert(_context, item)
  vim.notify(string.format("0x0: Added context %s (%d queued)", item.label, #_context), vim.log.levels.INFO)
end

---@param providers table[]
---@param callback fun(target?: zeroxzero.ActiveSession)
local function choose_new_session(providers, callback)
  if not providers or #providers == 0 then
    vim.notify("0x0: No providers available", vim.log.levels.ERROR)
    callback(nil)
    return
  end

  local preferred = config.current.provider
  if preferred then
    for _, provider in ipairs(providers) do
      if provider.id == preferred then
        callback({
          provider = provider.id,
          label = "New " .. provider_name(provider) .. " session",
        })
        return
      end
    end
  end

  if #providers == 1 then
    callback({
      provider = providers[1].id,
      label = "New " .. provider_name(providers[1]) .. " session",
    })
    return
  end

  vim.ui.select(providers, {
    prompt = "0x0 provider>",
    format_item = function(provider)
      return provider_name(provider)
    end,
  }, function(choice)
    if not choice then
      callback(nil)
      return
    end
    callback({
      provider = choice.id,
      label = "New " .. provider_name(choice) .. " session",
    })
  end)
end

---@return zeroxzero.ActiveSession?
function M.get_active()
  return _active
end

---@param session zeroxzero.ActiveSession?
function M.set_active(session)
  _active = session
end

function M.clear_active()
  _active = nil
end

---@param session_id string
---@param provider string
---@param label? string
function M.remember(session_id, provider, label)
  _active = {
    id = session_id,
    provider = provider,
    label = label or string.format("[%s] %s", provider, session_id:sub(1, 8)),
  }
  transport.remember_session(_active)
end

---@return integer
function M.context_count()
  return #_context
end

function M.clear_context()
  _context = {}
  vim.notify("0x0: Cleared queued context", vim.log.levels.INFO)
end

---@return zeroxzero.ContextItem[]
function M.consume_context()
  local items = _context
  _context = {}
  return items
end

function M.add_current_file_context()
  local bufnr = vim.api.nvim_get_current_buf()
  local filepath = vim.api.nvim_buf_get_name(bufnr)
  if filepath == "" then
    vim.notify("0x0: Buffer has no file", vim.log.levels.ERROR)
    return
  end

  add_context_item({
    kind = "file",
    filepath = filepath,
    filetype = vim.bo[bufnr].filetype,
    label = util.relative_path(filepath),
    lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
  })
end

function M.add_visual_context()
  local selection = util.get_visual_selection()
  if not selection then
    vim.notify("0x0: No selection", vim.log.levels.WARN)
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  local filepath = vim.api.nvim_buf_get_name(bufnr)
  if filepath == "" then
    vim.notify("0x0: Buffer has no file", vim.log.levels.ERROR)
    return
  end

  add_context_item({
    kind = "selection",
    filepath = filepath,
    filetype = vim.bo[bufnr].filetype,
    label = string.format("%s:%d-%d", util.relative_path(filepath), selection.start_line, selection.end_line),
    lines = selection.lines,
    start_line = selection.start_line,
    end_line = selection.end_line,
  })
end

---@param callback fun(target?: zeroxzero.ActiveSession)
function M.ensure_target(callback)
  if _active then
    callback(_active)
    return
  end

  transport.list_providers(function(err, providers)
    if err then
      vim.notify("0x0: Failed to list providers: " .. err, vim.log.levels.ERROR)
      callback(nil)
      return
    end
    choose_new_session(providers or {}, function(target)
      if not target then
        callback(nil)
        return
      end
      _active = target
      vim.notify("0x0: Active session target: " .. target.label, vim.log.levels.INFO)
      callback(target)
    end)
  end)
end

---@param callback? fun(target?: zeroxzero.ActiveSession)
function M.select(callback)
  transport.list_providers(function(provider_err, providers)
    if provider_err then
      vim.notify("0x0: Failed to list providers: " .. provider_err, vim.log.levels.ERROR)
      if callback then
        callback(nil)
      end
      return
    end

    transport.list_sessions(function(session_err, sessions)
      if session_err then
        vim.notify("0x0: Failed to list sessions: " .. session_err, vim.log.levels.ERROR)
        if callback then
          callback(nil)
        end
        return
      end

      local items = {}
      for _, provider in ipairs(providers or {}) do
        table.insert(items, {
          kind = "new",
          provider = provider.id,
          label = "New " .. provider_name(provider) .. " session",
        })
      end
      for _, session in ipairs(sessions or {}) do
        table.insert(items, {
          kind = "existing",
          session = session,
          label = format_session_label(session),
        })
      end

      if #items == 0 then
        vim.notify("0x0: No providers or sessions available", vim.log.levels.WARN)
        if callback then
          callback(nil)
        end
        return
      end

      vim.ui.select(items, {
        prompt = "0x0 sessions>",
        format_item = function(item)
          return item.label
        end,
      }, function(choice)
        if not choice then
          if callback then
            callback(nil)
          end
          return
        end

        if choice.kind == "existing" then
          M.remember(choice.session.id, choice.session.provider, choice.label)
        else
          _active = {
            provider = choice.provider,
            label = choice.label,
          }
        end

        vim.notify("0x0: Active session target: " .. _active.label, vim.log.levels.INFO)
        if callback then
          callback(_active)
        end
      end)
    end)
  end)
end

return M
