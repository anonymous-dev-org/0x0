--- Utility functions for the 0x0 nvim plugin.

local M = {}

--- Get the visual selection range and text.
---@return { start_line: integer, end_line: integer, lines: string[] }?
function M.get_visual_selection()
  local start_pos = vim.fn.getpos("'<")
  local end_pos = vim.fn.getpos("'>")
  local start_line = start_pos[2]
  local end_line = end_pos[2]

  if start_line == 0 or end_line == 0 then
    return nil
  end

  local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
  return {
    start_line = start_line,
    end_line = end_line,
    lines = lines,
  }
end

--- Expand cursor position to the enclosing treesitter node (function, class, etc).
---@param bufnr integer
---@return { start_line: integer, end_line: integer }?
function M.get_treesitter_scope(bufnr)
  local ok, ts = pcall(require, "nvim-treesitter.ts_utils")
  if not ok then
    -- Fallback: try native treesitter
    return M._get_native_treesitter_scope(bufnr)
  end

  local node = ts.get_node_at_cursor()
  if not node then
    return nil
  end

  -- Walk up to find a function/method/class node
  local scope_types = {
    function_definition = true,
    function_declaration = true,
    method_definition = true,
    method_declaration = true,
    class_definition = true,
    class_declaration = true,
    arrow_function = true,
    function_item = true, -- Rust
    impl_item = true, -- Rust
  }

  local current = node
  while current do
    if scope_types[current:type()] then
      local sr, _, er, _ = current:range()
      return { start_line = sr + 1, end_line = er + 1 }
    end
    current = current:parent()
  end

  return nil
end

--- Native treesitter scope detection without nvim-treesitter plugin.
---@param bufnr integer
---@return { start_line: integer, end_line: integer }?
function M._get_native_treesitter_scope(bufnr)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local row = cursor[1] - 1

  local ok, parser = pcall(vim.treesitter.get_parser, bufnr)
  if not ok or not parser then
    return nil
  end

  local tree = parser:parse()[1]
  if not tree then
    return nil
  end

  local root = tree:root()
  local node = root:named_descendant_for_range(row, 0, row, 0)
  if not node then
    return nil
  end

  local scope_types = {
    function_definition = true,
    function_declaration = true,
    method_definition = true,
    method_declaration = true,
    class_definition = true,
    class_declaration = true,
    arrow_function = true,
    function_item = true,
    impl_item = true,
  }

  local current = node
  while current do
    if scope_types[current:type()] then
      local sr, _, er, _ = current:range()
      return { start_line = sr + 1, end_line = er + 1 }
    end
    current = current:parent()
  end

  return nil
end

--- Get the relative path of a file from cwd.
---@param filepath string
---@return string
function M.relative_path(filepath)
  local cwd = vim.fn.getcwd()
  if filepath:sub(1, #cwd) == cwd then
    local rel = filepath:sub(#cwd + 2)
    if rel ~= "" then
      return rel
    end
  end
  return filepath
end

---@param bufnr integer
---@return table?
function M.buffer_snapshot(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return nil
  end

  local filepath = vim.api.nvim_buf_get_name(bufnr)
  return {
    filepath = filepath,
    relative_path = filepath ~= "" and M.relative_path(filepath) or "[No Name]",
    filetype = vim.bo[bufnr].filetype,
    lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
  }
end

---@return table[]
function M.collect_diagnostics()
  local items = {}
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(bufnr) then
      local filepath = vim.api.nvim_buf_get_name(bufnr)
      for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
        table.insert(items, {
          filepath = filepath,
          relative_path = filepath ~= "" and M.relative_path(filepath) or "[No Name]",
          line = diagnostic.lnum + 1,
          column = diagnostic.col + 1,
          severity = diagnostic.severity,
          message = diagnostic.message,
          source = diagnostic.source,
        })
      end
    end
  end
  return items
end

return M
