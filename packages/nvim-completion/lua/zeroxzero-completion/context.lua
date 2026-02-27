local config = require("zeroxzero-completion.config")

local M = {}

---@class zeroxzero_completion.Context
---@field prefix string
---@field suffix string
---@field language string
---@field filename string
---@field line number
---@field col number

local ft_to_lang = {
  typescript = "typescript",
  typescriptreact = "typescriptreact",
  javascript = "javascript",
  javascriptreact = "javascriptreact",
  python = "python",
  lua = "lua",
  rust = "rust",
  go = "go",
  c = "c",
  cpp = "cpp",
  java = "java",
  ruby = "ruby",
  php = "php",
  swift = "swift",
  kotlin = "kotlin",
  scala = "scala",
  zig = "zig",
  bash = "bash",
  sh = "sh",
  zsh = "zsh",
  css = "css",
  html = "html",
  json = "json",
  yaml = "yaml",
  toml = "toml",
  markdown = "markdown",
  vim = "vim",
}

---@return zeroxzero_completion.Context?
function M.get_context()
  local cfg = config.current
  local bufnr = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local row = cursor[1] -- 1-indexed
  local col = cursor[2] -- 0-indexed byte offset

  local total_lines = vim.api.nvim_buf_line_count(bufnr)
  if total_lines == 0 then
    return nil
  end

  -- Prefix: lines before cursor + current line up to cursor
  local prefix_start = math.max(1, row - cfg.max_prefix_lines)
  local prefix_lines = vim.api.nvim_buf_get_lines(bufnr, prefix_start - 1, row, false)
  if #prefix_lines > 0 then
    -- Truncate last line at cursor column
    local last = prefix_lines[#prefix_lines]
    prefix_lines[#prefix_lines] = last:sub(1, col)
  end
  local prefix = table.concat(prefix_lines, "\n")

  if prefix == "" then
    return nil
  end

  -- Suffix: rest of current line after cursor + lines after cursor
  local suffix_end = math.min(total_lines, row + cfg.max_suffix_lines)
  local suffix_lines = vim.api.nvim_buf_get_lines(bufnr, row - 1, suffix_end, false)
  if #suffix_lines > 0 then
    -- First line starts after cursor
    local first = suffix_lines[1]
    suffix_lines[1] = first:sub(col + 1)
  end
  local suffix = table.concat(suffix_lines, "\n")

  local ft = vim.bo[bufnr].filetype
  local language = ft_to_lang[ft] or ft

  local filename = vim.api.nvim_buf_get_name(bufnr)
  if filename ~= "" then
    filename = vim.fn.fnamemodify(filename, ":~:.")
  end

  return {
    prefix = prefix,
    suffix = suffix,
    language = language,
    filename = filename,
    line = row,
    col = col,
  }
end

return M
