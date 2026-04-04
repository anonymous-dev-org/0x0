--- Per-hunk inline review UI using virtual text.
--- Renders diffs as virtual text overlays so the buffer remains editable.

local M = {}

local ns = vim.api.nvim_create_namespace("zeroxzero_review")

---@class zeroxzero.ReviewState
---@field bufnr integer
---@field filepath string
---@field hunks zeroxzero.Hunk[]
---@field current_hunk integer Index into hunks (1-based)
---@field stash_ref string Git stash ref for restoring rejected hunks
---@field original_keymaps table Saved keymaps to restore on close
---@field on_complete? fun(accepted: string[], rejected: string[]) Callback when review finishes

---@type zeroxzero.ReviewState?
local _state = nil

--- Highlight groups for review UI.
local function setup_highlights()
  vim.api.nvim_set_hl(0, "ZeroReviewDelete", { link = "DiffDelete", default = true })
  vim.api.nvim_set_hl(0, "ZeroReviewAdd", { link = "DiffAdd", default = true })
  vim.api.nvim_set_hl(0, "ZeroReviewCurrentHunk", { link = "CursorLine", default = true })
end

--- Start a review session for a single file's hunks.
---@param opts { bufnr: integer, filepath: string, hunks: zeroxzero.Hunk[], stash_ref: string, on_complete?: fun(accepted: string[], rejected: string[]) }
function M.start(opts)
  if _state then
    M.cleanup()
  end

  setup_highlights()

  _state = {
    bufnr = opts.bufnr,
    filepath = opts.filepath,
    hunks = opts.hunks,
    current_hunk = 1,
    stash_ref = opts.stash_ref,
    original_keymaps = {},
    on_complete = opts.on_complete,
  }

  M._setup_keymaps()
  M._render_all_hunks()
  M._jump_to_hunk(1)
end

--- Render all pending hunks as virtual text.
function M._render_all_hunks()
  if not _state then
    return
  end

  -- Clear previous extmarks
  vim.api.nvim_buf_clear_namespace(_state.bufnr, ns, 0, -1)

  for i, hunk in ipairs(_state.hunks) do
    if hunk.status == "pending" then
      M._render_hunk(i, hunk)
    end
  end
end

--- Render a single hunk's virtual text.
---@param index integer
---@param hunk zeroxzero.Hunk
function M._render_hunk(index, hunk)
  if not _state then
    return
  end
  local bufnr = _state.bufnr

  local is_current = (index == _state.current_hunk)

  -- For modified hunks: highlight old lines with DiffDelete, show new lines as virtual lines
  if hunk.old_count > 0 then
    -- Highlight the old lines that will be replaced
    for j = 0, hunk.old_count - 1 do
      local line_nr = hunk.new_start - 1 + j -- 0-based
      if line_nr >= 0 and line_nr < vim.api.nvim_buf_line_count(bufnr) then
        vim.api.nvim_buf_set_extmark(bufnr, ns, line_nr, 0, {
          line_hl_group = is_current and "ZeroReviewCurrentHunk" or "ZeroReviewDelete",
          priority = 100,
        })
      end
    end
  end

  -- Show new lines as virtual lines (what the agent wrote, already in the file)
  if hunk.new_count > 0 and hunk.old_count > 0 then
    -- For modifications: show what the original looked like as virtual lines
    local virt_lines = {}
    for _, old_line in ipairs(hunk.old_lines) do
      table.insert(virt_lines, { { "- " .. old_line, "ZeroReviewDelete" } })
    end

    if #virt_lines > 0 then
      local anchor_line = hunk.new_start - 1 -- 0-based
      if anchor_line >= 0 and anchor_line < vim.api.nvim_buf_line_count(bufnr) then
        vim.api.nvim_buf_set_extmark(bufnr, ns, anchor_line, 0, {
          virt_lines_above = true,
          virt_lines = virt_lines,
          priority = 100,
        })
      end
    end
  elseif hunk.new_count > 0 and hunk.old_count == 0 then
    -- Pure addition: highlight the added lines
    for j = 0, hunk.new_count - 1 do
      local line_nr = hunk.new_start - 1 + j
      if line_nr >= 0 and line_nr < vim.api.nvim_buf_line_count(bufnr) then
        vim.api.nvim_buf_set_extmark(bufnr, ns, line_nr, 0, {
          line_hl_group = is_current and "ZeroReviewCurrentHunk" or "ZeroReviewAdd",
          priority = 100,
        })
      end
    end
  elseif hunk.old_count > 0 and hunk.new_count == 0 then
    -- Pure deletion: show deleted lines as virtual text
    local virt_lines = {}
    for _, old_line in ipairs(hunk.old_lines) do
      table.insert(virt_lines, { { "- " .. old_line, "ZeroReviewDelete" } })
    end
    -- Place at the position where lines were deleted
    local anchor = math.max(0, hunk.new_start - 1)
    if anchor < vim.api.nvim_buf_line_count(bufnr) then
      vim.api.nvim_buf_set_extmark(bufnr, ns, anchor, 0, {
        virt_lines_above = true,
        virt_lines = virt_lines,
        priority = 100,
      })
    end
  end

  -- Add sign for hunk marker
  local sign_line = math.max(0, hunk.new_start - 1)
  if sign_line < vim.api.nvim_buf_line_count(bufnr) then
    vim.api.nvim_buf_set_extmark(bufnr, ns, sign_line, 0, {
      sign_text = is_current and ">>" or "||",
      sign_hl_group = is_current and "ZeroReviewCurrentHunk" or "Comment",
      priority = 200,
    })
  end
end

--- Jump cursor to a hunk.
---@param index integer
function M._jump_to_hunk(index)
  if not _state then
    return
  end
  local hunk = _state.hunks[index]
  if not hunk then
    return
  end

  _state.current_hunk = index
  M._render_all_hunks()

  -- Move cursor to the hunk's position
  local target_line = hunk.new_start
  local line_count = vim.api.nvim_buf_line_count(_state.bufnr)
  target_line = math.min(target_line, line_count)
  target_line = math.max(target_line, 1)
  vim.api.nvim_win_set_cursor(0, { target_line, 0 })
  vim.cmd("normal! zz")
end

--- Navigate to the next pending hunk.
function M.next_hunk()
  if not _state then
    return
  end
  local start = _state.current_hunk
  for i = start + 1, #_state.hunks do
    if _state.hunks[i].status == "pending" then
      M._jump_to_hunk(i)
      return
    end
  end
  -- Wrap around
  for i = 1, start do
    if _state.hunks[i].status == "pending" then
      M._jump_to_hunk(i)
      return
    end
  end
end

--- Navigate to the previous pending hunk.
function M.prev_hunk()
  if not _state then
    return
  end
  local start = _state.current_hunk
  for i = start - 1, 1, -1 do
    if _state.hunks[i].status == "pending" then
      M._jump_to_hunk(i)
      return
    end
  end
  -- Wrap around
  for i = #_state.hunks, start, -1 do
    if _state.hunks[i].status == "pending" then
      M._jump_to_hunk(i)
      return
    end
  end
end

--- Accept the current hunk (keep the agent's changes).
function M.accept_hunk()
  if not _state then
    return
  end
  local hunk = _state.hunks[_state.current_hunk]
  if not hunk or hunk.status ~= "pending" then
    return
  end

  hunk.status = "accepted"
  M._advance_or_finish()
end

--- Reject the current hunk (restore original from snapshot).
function M.reject_hunk()
  if not _state then
    return
  end
  local hunk = _state.hunks[_state.current_hunk]
  if not hunk or hunk.status ~= "pending" then
    return
  end

  hunk.status = "rejected"

  -- Restore original lines for this hunk in the buffer
  local bufnr = _state.bufnr
  local start_0 = hunk.new_start - 1
  local end_0 = start_0 + hunk.new_count
  vim.api.nvim_buf_set_lines(bufnr, start_0, end_0, false, hunk.old_lines)

  -- Adjust subsequent hunk positions
  local delta = #hunk.old_lines - hunk.new_count
  for i = _state.current_hunk + 1, #_state.hunks do
    _state.hunks[i].new_start = _state.hunks[i].new_start + delta
  end

  M._advance_or_finish()
end

--- Accept all remaining pending hunks.
function M.accept_all()
  if not _state then
    return
  end
  for _, hunk in ipairs(_state.hunks) do
    if hunk.status == "pending" then
      hunk.status = "accepted"
    end
  end
  M._finish()
end

--- Reject all remaining pending hunks.
function M.reject_all()
  if not _state then
    return
  end
  -- Process from last to first to avoid line offset issues
  for i = #_state.hunks, 1, -1 do
    local hunk = _state.hunks[i]
    if hunk.status == "pending" then
      hunk.status = "rejected"
      local bufnr = _state.bufnr
      local start_0 = hunk.new_start - 1
      local end_0 = start_0 + hunk.new_count
      vim.api.nvim_buf_set_lines(bufnr, start_0, end_0, false, hunk.old_lines)
    end
  end
  M._finish()
end

--- Advance to next pending hunk, or finish if none remain.
function M._advance_or_finish()
  if not _state then
    return
  end

  local has_pending = false
  for _, hunk in ipairs(_state.hunks) do
    if hunk.status == "pending" then
      has_pending = true
      break
    end
  end

  if not has_pending then
    M._finish()
  else
    M._render_all_hunks()
    M.next_hunk()
  end
end

--- Finish the review session.
function M._finish()
  if not _state then
    return
  end

  local accepted = {}
  local rejected = {}
  for _, hunk in ipairs(_state.hunks) do
    if hunk.status == "accepted" then
      table.insert(accepted, hunk)
    elseif hunk.status == "rejected" then
      table.insert(rejected, hunk)
    end
  end

  local on_complete = _state.on_complete
  local filepath = _state.filepath

  -- Count results
  local na = #accepted
  local nr = #rejected

  M.cleanup()

  vim.notify(string.format("0x0: %s — %d accepted, %d rejected", filepath, na, nr), vim.log.levels.INFO)

  if on_complete then
    on_complete(accepted, rejected)
  end
end

--- Set up review keymaps on the buffer.
function M._setup_keymaps()
  if not _state then
    return
  end
  local bufnr = _state.bufnr
  local opts = { buffer = bufnr, nowait = true, silent = true }

  local cfg = require("zeroxzero.config").current

  vim.keymap.set("n", cfg.keymaps.next_hunk, function()
    M.next_hunk()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.prev_hunk, function()
    M.prev_hunk()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.accept, function()
    M.accept_hunk()
  end, opts)
  vim.keymap.set("n", "co", function()
    M.accept_hunk()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.reject, function()
    M.reject_hunk()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.accept_all, function()
    M.accept_all()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.reject_all, function()
    M.reject_all()
  end, opts)
  vim.keymap.set("n", cfg.keymaps.quit, function()
    M.reject_all()
  end, opts)
end

--- Clean up review state, keymaps, and virtual text.
function M.cleanup()
  if not _state then
    return
  end

  vim.api.nvim_buf_clear_namespace(_state.bufnr, ns, 0, -1)

  -- Remove buffer-local keymaps
  local bufnr = _state.bufnr
  local cfg = require("zeroxzero.config").current
  local keys = {
    cfg.keymaps.next_hunk,
    cfg.keymaps.prev_hunk,
    cfg.keymaps.accept,
    "co",
    cfg.keymaps.reject,
    cfg.keymaps.accept_all,
    cfg.keymaps.reject_all,
    cfg.keymaps.quit,
  }
  for _, key in ipairs(keys) do
    pcall(vim.keymap.del, "n", key, { buffer = bufnr })
  end

  _state = nil
end

--- Check if a review is currently active.
---@return boolean
function M.is_active()
  return _state ~= nil
end

return M
