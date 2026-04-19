--- Chat workflow built on top of shared provider sessions.

local edit = require("zeroxzero.edit")
local session = require("zeroxzero.session")

local M = {}

local function fence(filetype, lines)
  local ft = filetype or ""
  return string.format("```%s\n%s\n```", ft, table.concat(lines, "\n"))
end

---@param instruction string
---@param items zeroxzero.ContextItem[]
local function build_prompt(instruction, items)
  if #items == 0 then
    return instruction
  end

  local blocks = {
    "Use the provided context if it is relevant.",
    "",
    "User request:",
    instruction,
    "",
    "Context:",
  }

  for _, item in ipairs(items) do
    local header = item.kind == "selection"
      and string.format("Selection: %s", item.label)
      or string.format("File: %s", item.label)
    table.insert(blocks, header)
    table.insert(blocks, fence(item.filetype, item.lines))
    table.insert(blocks, "")
  end

  return table.concat(blocks, "\n")
end

---@param target zeroxzero.ActiveSession
---@param instruction string
local function send_prompt(target, instruction)
  if edit.is_active() then
    vim.notify("0x0: A request is already in progress", vim.log.levels.WARN)
    return
  end

  local context_items = session.consume_context()
  edit.run({
    prompt = build_prompt(instruction, context_items),
    provider = target.provider,
    session_id = target.id,
    nvim_context = {
      queued_context = context_items,
    },
    on_session = function(session_id)
      session.remember(session_id, target.provider)
    end,
  })
end

function M.select_session()
  session.select()
end

function M.add_context()
  session.add_current_file_context()
end

function M.add_context_visual()
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
  vim.schedule(function()
    session.add_visual_context()
  end)
end

function M.clear_context()
  session.clear_context()
end

function M.send()
  session.ensure_target(function(target)
    if not target then
      return
    end

    local label = target.label or string.format("[%s]", target.provider)
    local queued = session.context_count()
    local prompt = queued > 0
      and string.format("0x0 chat (%s, %d ctx)> ", label, queued)
      or string.format("0x0 chat (%s)> ", label)

    vim.ui.input({ prompt = prompt }, function(instruction)
      if not instruction or instruction == "" then
        return
      end
      send_prompt(target, instruction)
    end)
  end)
end

function M.get_active_session()
  return session.get_active()
end

---@param session_id string
---@param provider string
---@param label? string
function M.remember_session(session_id, provider, label)
  session.remember(session_id, provider, label)
end

function M.abort()
  edit.abort()
end

return M
