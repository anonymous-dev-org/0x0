local M = {}

local ns = vim.api.nvim_create_namespace("zeroxzero_completion")

---@type string
M._text = ""
---@type number?
M._extmark_id = nil
---@type number?
M._bufnr = nil
---@type number?
M._row = nil
---@type number?
M._col = nil

---@return boolean
function M.is_visible()
  return M._extmark_id ~= nil
end

---Show ghost text at the current cursor position
---@param text string
function M.show(text)
  M.clear()

  if not text or text == "" then
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local row = cursor[1] - 1 -- 0-indexed
  local col = cursor[2]

  M._text = text
  M._bufnr = bufnr
  M._row = row
  M._col = col

  local lines = vim.split(text, "\n", { plain = true })

  -- Get the text after cursor on the current line for overlay
  local current_line = vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1] or ""
  local suffix_on_line = current_line:sub(col + 1)

  -- Build extmark options
  local opts = {
    hl_mode = "combine",
  }

  -- First line: overlay virtual text (replaces visual rendering from cursor onward)
  local first_line_text = lines[1] .. suffix_on_line
  opts.virt_text = { { first_line_text, "ZeroCompletion" } }
  opts.virt_text_pos = "overlay"

  -- Additional lines: virtual lines below
  if #lines > 1 then
    local virt_lines = {}
    for i = 2, #lines do
      table.insert(virt_lines, { { lines[i], "ZeroCompletion" } })
    end
    opts.virt_lines = virt_lines
  end

  M._extmark_id = vim.api.nvim_buf_set_extmark(bufnr, ns, row, col, opts)
end

---Append delta text to the current ghost (streaming incremental update)
---@param delta string
function M.append(delta)
  M._text = M._text .. delta
  if M._bufnr and M._row and M._col then
    -- Re-render at original position
    local old_id = M._extmark_id
    local bufnr = M._bufnr
    local row = M._row
    local col = M._col

    if old_id then
      vim.api.nvim_buf_del_extmark(bufnr, ns, old_id)
    end

    local text = M._text
    local lines = vim.split(text, "\n", { plain = true })
    local current_line = vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1] or ""
    local suffix_on_line = current_line:sub(col + 1)

    local opts = {
      hl_mode = "combine",
      virt_text = { { lines[1] .. suffix_on_line, "ZeroCompletion" } },
      virt_text_pos = "overlay",
    }

    if #lines > 1 then
      local virt_lines = {}
      for i = 2, #lines do
        table.insert(virt_lines, { { lines[i], "ZeroCompletion" } })
      end
      opts.virt_lines = virt_lines
    end

    M._extmark_id = vim.api.nvim_buf_set_extmark(bufnr, ns, row, col, opts)
  end
end

---Accept the full ghost text — insert it into the buffer
function M.accept()
  if not M.is_visible() or M._text == "" then
    return false
  end

  local bufnr = M._bufnr
  local row = M._row
  local col = M._col
  local text = M._text

  M.clear()

  if not bufnr or not row or not col then
    return false
  end

  local lines = vim.split(text, "\n", { plain = true })
  local current_line = vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1] or ""
  local before = current_line:sub(1, col)
  local after = current_line:sub(col + 1)

  -- Build replacement lines
  local new_lines = {}
  for i, line in ipairs(lines) do
    if i == 1 then
      table.insert(new_lines, before .. line)
    else
      table.insert(new_lines, line)
    end
  end
  -- Append suffix to last line
  new_lines[#new_lines] = new_lines[#new_lines] .. after

  vim.api.nvim_buf_set_lines(bufnr, row, row + 1, false, new_lines)

  -- Move cursor to end of inserted text (before the suffix)
  local end_row = row + #lines - 1
  local end_col = #lines == 1 and (col + #lines[1]) or #lines[#lines]
  vim.api.nvim_win_set_cursor(0, { end_row + 1, end_col })

  return true
end

---Accept just the first word of the ghost text
function M.accept_word()
  if not M.is_visible() or M._text == "" then
    return false
  end

  -- Find the first word boundary
  local word_end = M._text:find("[%s%p]")
  if not word_end then
    -- Entire text is one word
    return M.accept()
  end

  -- Include the delimiter if it's whitespace
  if M._text:sub(word_end, word_end):match("%s") then
    word_end = word_end
  else
    word_end = word_end - 1
  end

  if word_end < 1 then
    word_end = 1
  end

  local word = M._text:sub(1, word_end)
  local remainder = M._text:sub(word_end + 1)

  local bufnr = M._bufnr
  local row = M._row
  local col = M._col

  M.clear()

  if not bufnr or not row or not col then
    return false
  end

  -- Insert the word
  local current_line = vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1] or ""
  local before = current_line:sub(1, col)
  local after = current_line:sub(col + 1)

  local word_lines = vim.split(word, "\n", { plain = true })
  local new_lines = {}
  for i, line in ipairs(word_lines) do
    if i == 1 then
      table.insert(new_lines, before .. line)
    else
      table.insert(new_lines, line)
    end
  end
  new_lines[#new_lines] = new_lines[#new_lines] .. after

  vim.api.nvim_buf_set_lines(bufnr, row, row + 1, false, new_lines)

  local end_row = row + #word_lines - 1
  local end_col = #word_lines == 1 and (col + #word_lines[1]) or #word_lines[#word_lines]
  vim.api.nvim_win_set_cursor(0, { end_row + 1, end_col })

  -- Show remainder as ghost if any
  if remainder ~= "" then
    vim.schedule(function()
      M.show(remainder)
    end)
  end

  return true
end

---Accept just the first line of the ghost text
function M.accept_line()
  if not M.is_visible() or M._text == "" then
    return false
  end

  local newline_pos = M._text:find("\n")
  if not newline_pos then
    return M.accept()
  end

  local first_line = M._text:sub(1, newline_pos - 1)
  local remainder = M._text:sub(newline_pos + 1)

  local bufnr = M._bufnr
  local row = M._row
  local col = M._col

  M.clear()

  if not bufnr or not row or not col then
    return false
  end

  -- Insert the first line
  local current_line = vim.api.nvim_buf_get_lines(bufnr, row, row + 1, false)[1] or ""
  local before = current_line:sub(1, col)
  local after = current_line:sub(col + 1)

  vim.api.nvim_buf_set_lines(bufnr, row, row + 1, false, { before .. first_line .. after })
  vim.api.nvim_win_set_cursor(0, { row + 1, col + #first_line })

  -- Show remainder as ghost if any
  if remainder ~= "" then
    vim.schedule(function()
      M.show(remainder)
    end)
  end

  return true
end

---Clear ghost text
function M.clear()
  if M._extmark_id and M._bufnr then
    pcall(vim.api.nvim_buf_del_extmark, M._bufnr, ns, M._extmark_id)
  end
  M._extmark_id = nil
  M._bufnr = nil
  M._row = nil
  M._col = nil
  M._text = ""
end

return M
