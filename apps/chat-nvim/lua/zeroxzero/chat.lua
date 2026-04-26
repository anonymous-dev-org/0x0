local config = require("zeroxzero.config")
local acp_client = require("zeroxzero.acp_client")
local permission = require("zeroxzero.permission")

local M = {}
local api = vim.api

local USER_HEADING = "## User"
local ASSISTANT_HEADING_PREFIX = "## Assistant"
local BUFFER_NAME = "[0x0 Chat]"

---@class zeroxzero.ChatState
---@field bufnr integer|nil
---@field winid integer|nil
---@field client table|nil
---@field session_id string|nil
---@field provider_name string|nil
---@field model string|nil
---@field assistant_line integer|nil  -- 0-indexed line currently being streamed
---@field in_flight boolean
---@field pending_permission table|nil
---@field tool_calls table<string, { mark: integer, kind: string, title: string, status: string }>
local state = {
  bufnr = nil,
  winid = nil,
  client = nil,
  session_id = nil,
  provider_name = nil,
  model = nil,
  assistant_line = nil,
  in_flight = false,
  pending_permission = nil,
  tool_calls = {},
}

local NS = api.nvim_create_namespace("zeroxzero_chat_tools")

local STATUS_ICONS = {
  pending = "·",
  in_progress = "⠋",
  completed = "✓",
  failed = "✗",
}

local function buf_valid()
  return state.bufnr and api.nvim_buf_is_valid(state.bufnr)
end

local function set_modifiable(value)
  if buf_valid() then vim.bo[state.bufnr].modifiable = value end
end

local function append_lines(lines)
  if not buf_valid() then return end
  set_modifiable(true)
  local last = api.nvim_buf_line_count(state.bufnr)
  api.nvim_buf_set_lines(state.bufnr, last, last, false, lines)
  set_modifiable(false)
end

local function find_window_for_buffer()
  if not buf_valid() then return nil end
  for _, win in ipairs(api.nvim_list_wins()) do
    if api.nvim_win_get_buf(win) == state.bufnr then return win end
  end
  return nil
end

local function ensure_buffer()
  if buf_valid() then return state.bufnr end

  local bufnr = api.nvim_create_buf(false, true)
  api.nvim_buf_set_name(bufnr, BUFFER_NAME)
  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].bufhidden = "hide"
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].filetype = "markdown"
  state.bufnr = bufnr

  api.nvim_buf_set_lines(bufnr, 0, -1, false, { USER_HEADING, "" })
  set_modifiable(true)

  vim.keymap.set("n", "<CR>", function() M.submit() end, { buffer = bufnr, desc = "Submit chat prompt" })
  vim.keymap.set("n", "<localleader>c", function() M.cancel() end, { buffer = bufnr, desc = "Cancel chat run" })

  return bufnr
end

local function ensure_window()
  local win = find_window_for_buffer()
  if win and api.nvim_win_is_valid(win) then
    state.winid = win
    return win
  end
  vim.cmd("botright vsplit")
  win = api.nvim_get_current_win()
  api.nvim_win_set_buf(win, ensure_buffer())
  api.nvim_win_set_width(win, math.max(60, math.floor(vim.o.columns * (config.current.width or 0.4))))
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  state.winid = win
  return win
end

local function assistant_heading()
  local label = state.provider_name or "assistant"
  return ("%s (%s)"):format(ASSISTANT_HEADING_PREFIX, label)
end

local function read_pending_prompt()
  if not buf_valid() then return "" end
  local lines = api.nvim_buf_get_lines(state.bufnr, 0, -1, false)
  local user_line = nil
  for i = #lines, 1, -1 do
    if lines[i] == USER_HEADING then
      user_line = i
      break
    end
  end
  if not user_line then return "" end
  local prompt_lines = {}
  for i = user_line + 1, #lines do
    prompt_lines[#prompt_lines + 1] = lines[i]
  end
  return vim.trim(table.concat(prompt_lines, "\n"))
end

---@param call { kind: string, title: string, status: string }
local function format_tool_line(call)
  local icon = STATUS_ICONS[call.status] or "·"
  local title = call.title ~= "" and call.title or "(no title)"
  return ("%s %s — %s"):format(icon, call.kind, title)
end

---@param update table
local function render_tool_call(update)
  if not buf_valid() then return end
  local id = update.toolCallId
  if not id then return end

  local existing = state.tool_calls[id]
  if existing then
    existing.status = update.status or existing.status
    if update.title and update.title ~= "" then existing.title = update.title end
    if update.kind then existing.kind = update.kind end
    local pos = api.nvim_buf_get_extmark_by_id(state.bufnr, NS, existing.mark, {})
    if not pos[1] then return end
    set_modifiable(true)
    api.nvim_buf_set_lines(state.bufnr, pos[1], pos[1] + 1, false, { format_tool_line(existing) })
    set_modifiable(false)
    return
  end

  local last = api.nvim_buf_line_count(state.bufnr)
  local call = {
    kind = update.kind or "tool",
    title = update.title or "",
    status = update.status or "pending",
    mark = 0,
  }
  set_modifiable(true)
  api.nvim_buf_set_lines(state.bufnr, last, last, false, { format_tool_line(call) })
  set_modifiable(false)
  call.mark = api.nvim_buf_set_extmark(state.bufnr, NS, last, 0, {})
  state.tool_calls[id] = call
  state.assistant_line = nil
end

---@param text string
local function append_chunk(text)
  if not buf_valid() then return end
  set_modifiable(true)
  if not state.assistant_line then
    local last = api.nvim_buf_line_count(state.bufnr)
    api.nvim_buf_set_lines(state.bufnr, last, last, false, { "" })
    state.assistant_line = last
  end
  local line = state.assistant_line
  local current = api.nvim_buf_get_lines(state.bufnr, line, line + 1, false)[1] or ""
  local pieces = vim.split(text, "\n", { plain = true })
  pieces[1] = current .. pieces[1]
  api.nvim_buf_set_lines(state.bufnr, line, line + 1, false, pieces)
  state.assistant_line = line + #pieces - 1
  set_modifiable(false)
end

local function open_for_next_prompt()
  append_lines({ "", USER_HEADING, "" })
  state.assistant_line = nil
  state.in_flight = false
end

local function reset_session()
  if state.pending_permission then
    pcall(state.pending_permission.unmap)
    state.pending_permission = nil
  end
  if state.client and state.session_id then
    state.client:cancel(state.session_id)
    state.client:unsubscribe(state.session_id)
  end
  if state.client then state.client:stop() end
  state.client = nil
  state.session_id = nil
  state.assistant_line = nil
  state.in_flight = false
  state.tool_calls = {}
end

---@param on_ready fun(client: table)
local function ensure_client(on_ready)
  local provider_name = state.provider_name or config.current.provider
  if state.client and state.provider_name == provider_name and state.client:is_ready() then
    on_ready(state.client)
    return
  end

  local provider, err = config.resolve_provider(provider_name)
  if not provider then
    vim.notify(err, vim.log.levels.ERROR)
    return
  end

  if state.client then state.client:stop() end
  state.provider_name = provider_name
  state.client = acp_client.new(provider)
  state.client:start(function(c) on_ready(c) end)
end

---@param on_session fun(client: table, session_id: string)
local function ensure_session(on_session)
  ensure_client(function(client)
    if state.session_id then
      on_session(client, state.session_id)
      return
    end
    client:new_session(vim.fn.getcwd(), function(result, err)
      if err or not result or not result.sessionId then
        vim.notify("acp: session/new failed: " .. vim.inspect(err), vim.log.levels.ERROR)
        return
      end
      state.session_id = result.sessionId

      client:subscribe(result.sessionId, {
        on_update = function(update)
          local kind = update.sessionUpdate
          if kind == "agent_message_chunk" or kind == "agent_thought_chunk" then
            local text = update.content and update.content.text or ""
            if text ~= "" then vim.schedule(function() append_chunk(text) end) end
          elseif kind == "tool_call" or kind == "tool_call_update" then
            vim.schedule(function() render_tool_call(update) end)
          end
        end,
        on_request_permission = function(request, respond)
          vim.schedule(function()
            if state.pending_permission then
              respond("reject_once")
              return
            end
            local pending = permission.render(state.bufnr, request, function(option_id)
              state.pending_permission = nil
              respond(option_id)
            end)
            if pending then
              state.pending_permission = pending
              state.assistant_line = nil
            else
              respond("reject_once")
            end
          end)
        end,
      })

      if state.model then
        client:set_model(result.sessionId, state.model, function() end)
      end

      on_session(client, result.sessionId)
    end)
  end)
end

function M.open()
  ensure_buffer()
  ensure_window()
end

function M.new()
  reset_session()
  if buf_valid() then
    set_modifiable(true)
    api.nvim_buf_set_lines(state.bufnr, 0, -1, false, { USER_HEADING, "" })
    set_modifiable(false)
  end
  M.open()
end

function M.submit()
  ensure_buffer()
  if state.in_flight then
    vim.notify("acp: prompt already in flight", vim.log.levels.WARN)
    return
  end
  local prompt = read_pending_prompt()
  if prompt == "" then
    vim.notify("acp: empty prompt", vim.log.levels.WARN)
    return
  end

  state.in_flight = true
  append_lines({ "", assistant_heading(), "" })
  state.assistant_line = api.nvim_buf_line_count(state.bufnr) - 1

  ensure_session(function(client, session_id)
    client:prompt(session_id, { { type = "text", text = prompt } }, function(result, err)
      vim.schedule(function()
        if err then
          local msg = type(err) == "table" and (err.message or vim.inspect(err)) or tostring(err)
          append_lines({ "", "_error: " .. msg .. "_" })
        elseif result and result.stopReason and result.stopReason ~= "end_turn" then
          append_lines({ "", "_stopped: " .. tostring(result.stopReason) .. "_" })
        end
        open_for_next_prompt()
      end)
    end)
  end)
end

function M.cancel()
  if state.client and state.session_id and state.in_flight then
    state.client:cancel(state.session_id)
  end
end

function M.stop()
  reset_session()
  state.assistant_line = nil
end

---@return { provider: string, model: string|nil }
function M.current_settings()
  return {
    provider = state.provider_name or config.current.provider,
    model = state.model,
  }
end

---@param name string
function M.set_provider(name)
  reset_session()
  state.provider_name = name
end

---@param model string|nil
function M.set_model(model)
  state.model = model
  if state.client and state.session_id then
    state.client:set_model(state.session_id, model, function() end)
  end
end

return M
