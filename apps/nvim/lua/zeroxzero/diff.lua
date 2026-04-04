--- Diff computation for the 0x0 nvim plugin.
--- Computes per-file hunks from git diff or vim.diff().

local M = {}

---@class zeroxzero.Hunk
---@field old_start integer 1-based line in original
---@field old_count integer
---@field new_start integer 1-based line in new code
---@field new_count integer
---@field old_lines string[] Lines removed
---@field new_lines string[] Lines added
---@field status "pending"|"accepted"|"rejected"

---@class zeroxzero.FileDiff
---@field filepath string Relative path
---@field hunks zeroxzero.Hunk[]
---@field status "modified"|"added"|"deleted"

--- Compute file diffs from a git diff against a snapshot ref.
---@param stash_ref string
---@param callback fun(err?: string, file_diffs?: zeroxzero.FileDiff[])
function M.compute_from_git(stash_ref, callback)
  vim.fn.jobstart({ "git", "diff", "-U0", stash_ref, "--", "." }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      vim.schedule(function()
        local diff_text = table.concat(data or {}, "\n")
        local file_diffs = M.parse_unified_diff(diff_text)
        callback(nil, file_diffs)
      end)
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        vim.schedule(function()
          callback("git diff failed")
        end)
      end
    end,
  })
end

--- Parse a unified diff string into structured file diffs with hunks.
---@param diff_text string
---@return zeroxzero.FileDiff[]
function M.parse_unified_diff(diff_text)
  local file_diffs = {}
  local current_file = nil
  local current_hunk = nil

  for line in diff_text:gmatch("[^\n]*") do
    -- Detect file header: diff --git a/path b/path
    local filepath = line:match("^diff %-%-git a/(.-) b/")
    if filepath then
      current_file = {
        filepath = filepath,
        hunks = {},
        status = "modified",
      }
      table.insert(file_diffs, current_file)
      current_hunk = nil
    end

    -- Detect new file
    if line:match("^new file mode") and current_file then
      current_file.status = "added"
    end

    -- Detect deleted file
    if line:match("^deleted file mode") and current_file then
      current_file.status = "deleted"
    end

    -- Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
    local os_str, oc_str, ns_str, nc_str = line:match("^@@ %-(%d+),?(%d*) %+(%d+),?(%d*) @@")
    if os_str and current_file then
      current_hunk = {
        old_start = tonumber(os_str),
        old_count = tonumber(oc_str) or 1,
        new_start = tonumber(ns_str),
        new_count = tonumber(nc_str) or 1,
        old_lines = {},
        new_lines = {},
        status = "pending",
      }
      table.insert(current_file.hunks, current_hunk)
    end

    -- Collect hunk lines
    if current_hunk then
      if line:sub(1, 1) == "-" and not line:match("^%-%-%-") then
        table.insert(current_hunk.old_lines, line:sub(2))
      elseif line:sub(1, 1) == "+" and not line:match("^%+%+%+") then
        table.insert(current_hunk.new_lines, line:sub(2))
      end
    end
  end

  return file_diffs
end

--- Compute hunks between two sets of lines using vim.diff().
---@param original_lines string[]
---@param new_lines string[]
---@return zeroxzero.Hunk[]
function M.compute_inline(original_lines, new_lines)
  local old_text = table.concat(original_lines, "\n") .. "\n"
  local new_text = table.concat(new_lines, "\n") .. "\n"

  local diff_text = vim.diff(old_text, new_text, { algorithm = "histogram" })
  if not diff_text or diff_text == "" then
    return {}
  end

  local hunks = {}
  local current_hunk = nil

  for line in diff_text:gmatch("[^\n]*") do
    local os_str, oc_str, ns_str, nc_str = line:match("^@@ %-(%d+),?(%d*) %+(%d+),?(%d*) @@")
    if os_str then
      current_hunk = {
        old_start = tonumber(os_str),
        old_count = tonumber(oc_str) or 1,
        new_start = tonumber(ns_str),
        new_count = tonumber(nc_str) or 1,
        old_lines = {},
        new_lines = {},
        status = "pending",
      }
      table.insert(hunks, current_hunk)
    end

    if current_hunk then
      if line:sub(1, 1) == "-" and not line:match("^%-%-%-") then
        table.insert(current_hunk.old_lines, line:sub(2))
      elseif line:sub(1, 1) == "+" and not line:match("^%+%+%+") then
        table.insert(current_hunk.new_lines, line:sub(2))
      end
    end
  end

  return hunks
end

return M
