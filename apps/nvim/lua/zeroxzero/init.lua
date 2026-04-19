--- 0x0-nvim: AI-powered code editing with inline review.
--- Select code, instruct an LLM agent, review changes per-hunk.

local M = {}

--- Set up the plugin with user configuration.
---@param opts? table
function M.setup(opts)
  local config = require("zeroxzero.config")
  config.setup(opts)

  local cfg = config.current
  local km = cfg.keymaps

  if km.session and km.session ~= "" then
    vim.keymap.set("n", km.session, function()
      M.select_session()
    end, { desc = "0x0: Select Claude/Codex session" })
  end

  if km.chat and km.chat ~= "" then
    vim.keymap.set("n", km.chat, function()
      M.chat()
    end, { desc = "0x0: Chat with active session" })
  end

  if km.add_context and km.add_context ~= "" then
    vim.keymap.set("n", km.add_context, function()
      M.add_context()
    end, { desc = "0x0: Queue current file as context" })

    vim.keymap.set("v", km.add_context, function()
      M.add_context_visual()
    end, { desc = "0x0: Queue selection as context" })
  end

  if km.clear_context and km.clear_context ~= "" then
    vim.keymap.set("n", km.clear_context, function()
      M.clear_context()
    end, { desc = "0x0: Clear queued context" })
  end

  -- Edit keymap (normal mode: treesitter scope, visual mode: selection)
  if km.edit and km.edit ~= "" then
    vim.keymap.set("n", km.edit, function()
      M.edit()
    end, { desc = "0x0: Edit code with AI" })

    vim.keymap.set("v", km.edit, function()
      M.edit_visual()
    end, { desc = "0x0: Edit selection with AI" })
  end
end

function M.select_session()
  require("zeroxzero.chat").select_session()
end

function M.chat()
  require("zeroxzero.chat").send()
end

function M.add_context()
  require("zeroxzero.chat").add_context()
end

function M.add_context_visual()
  require("zeroxzero.chat").add_context_visual()
end

function M.clear_context()
  require("zeroxzero.chat").clear_context()
end

--- Start an edit from normal mode using treesitter scope detection.
function M.edit()
  local config = require("zeroxzero.config")
  local util = require("zeroxzero.util")
  local edit = require("zeroxzero.edit")

  local bufnr = vim.api.nvim_get_current_buf()
  local scope

  if config.current.auto_select == "treesitter" then
    scope = util.get_treesitter_scope(bufnr)
  end

  if not scope then
    -- Fallback: use current line
    local cursor = vim.api.nvim_win_get_cursor(0)
    scope = { start_line = cursor[1], end_line = cursor[1] }
  end

  edit.start({
    bufnr = bufnr,
    start_line = scope.start_line,
    end_line = scope.end_line,
  })
end

--- Start an edit from visual mode using the selection.
function M.edit_visual()
  local edit = require("zeroxzero.edit")

  -- Exit visual mode to set marks
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)

  vim.schedule(function()
    local util = require("zeroxzero.util")
    local sel = util.get_visual_selection()
    if not sel then
      vim.notify("0x0: No selection", vim.log.levels.WARN)
      return
    end

    edit.start({
      bufnr = vim.api.nvim_get_current_buf(),
      start_line = sel.start_line,
      end_line = sel.end_line,
    })
  end)
end

--- Abort the current edit session and restore files.
function M.abort()
  require("zeroxzero.edit").abort()
end

return M
