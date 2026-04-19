--- Git-based file snapshotting for tracking and reverting agent changes.
--- Uses `git stash create` for non-destructive snapshots.

local M = {}

--- Create a snapshot of the current working tree state.
--- Uses `git stash create` which creates a stash commit without modifying
--- the working tree or index.
---@param callback fun(err?: string, stash_ref?: string)
function M.create(callback)
  vim.fn.jobstart({ "git", "stash", "create" }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      local ref = data and data[1] and data[1]:match("^%S+")
      vim.schedule(function()
        if ref and ref ~= "" then
          callback(nil, ref)
        else
          -- No changes to stash — record HEAD as the reference
          M._get_head(function(err, head_ref)
            if err then
              callback(err)
            else
              callback(nil, head_ref)
            end
          end)
        end
      end)
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        vim.schedule(function()
          callback("git stash create failed with code " .. code)
        end)
      end
    end,
  })
end

--- Get the current HEAD ref.
---@param callback fun(err?: string, ref?: string)
function M._get_head(callback)
  vim.fn.jobstart({ "git", "rev-parse", "HEAD" }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      local ref = data and data[1] and data[1]:match("^%S+")
      vim.schedule(function()
        if ref and ref ~= "" then
          callback(nil, ref)
        else
          callback("failed to get HEAD")
        end
      end)
    end,
  })
end

--- Get the diff between the snapshot and the current working tree.
--- Returns a unified diff string.
---@param stash_ref string
---@param callback fun(err?: string, diff?: string)
function M.get_diff(stash_ref, callback)
  vim.fn.jobstart({ "git", "diff", stash_ref, "--", "." }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      vim.schedule(function()
        local diff_text = table.concat(data or {}, "\n")
        callback(nil, diff_text)
      end)
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        vim.schedule(function()
          callback("git diff failed with code " .. code)
        end)
      end
    end,
  })
end

--- Get list of files changed since the snapshot.
---@param stash_ref string
---@param callback fun(err?: string, files?: string[])
function M.get_changed_files(stash_ref, callback)
  vim.fn.jobstart({ "git", "diff", "--name-only", stash_ref, "--", "." }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      vim.schedule(function()
        local files = {}
        for _, f in ipairs(data or {}) do
          if f ~= "" then
            table.insert(files, f)
          end
        end
        callback(nil, files)
      end)
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        vim.schedule(function()
          callback("git diff --name-only failed")
        end)
      end
    end,
  })
end

--- Restore a single file from the snapshot.
---@param stash_ref string
---@param filepath string Relative path from repo root
---@param callback fun(err?: string)
function M.restore_file(stash_ref, filepath, callback)
  vim.fn.jobstart({ "git", "restore", "--worktree", "--source", stash_ref, "--", filepath }, {
    on_exit = function(_, code)
      vim.schedule(function()
        if code == 0 then
          callback(nil)
        else
          -- File may not exist in the snapshot (newly created)
          -- Try to remove it instead
          local abs = vim.fn.getcwd() .. "/" .. filepath
          local ok = os.remove(abs)
          if ok then
            callback(nil)
          else
            callback("Failed to restore " .. filepath)
          end
        end
      end)
    end,
  })
end

return M
