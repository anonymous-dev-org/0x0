--- Edit flow orchestration for the 0x0 nvim plugin.
--- Manages the full lifecycle: snapshot → prompt → stream → diff → review.

local config = require("zeroxzero.config")
local snapshot = require("zeroxzero.snapshot")
local diff = require("zeroxzero.diff")
local review = require("zeroxzero.review")
local transport = require("zeroxzero.transport")
local util = require("zeroxzero.util")

local M = {}

---@class zeroxzero.EditState
---@field bufnr? integer
---@field filepath? string
---@field stash_ref string
---@field provider? string
---@field session_id? string
---@field abort_fn? fun()
---@field on_session? fun(session_id: string, provider: string)
---@field active boolean

---@type zeroxzero.EditState?
local _state = nil

---@param opts { prompt: string, bufnr?: integer, filepath?: string, nvim_context?: table }
local function build_nvim_context(opts)
  local bufnr = opts.bufnr or vim.api.nvim_get_current_buf()
  return vim.tbl_deep_extend("force", {
    cwd = vim.fn.getcwd(),
    prompt = opts.prompt,
    active_buffer = util.buffer_snapshot(bufnr),
    diagnostics = util.collect_diagnostics(),
  }, opts.nvim_context or {})
end

---@param opts { prompt: string, append_system_prompt?: string, provider?: string, session_id?: string, on_session?: fun(session_id: string, provider: string), bufnr?: integer, filepath?: string, nvim_context?: table }
function M.run(opts)
  if _state and _state.active then
    vim.notify("0x0: An edit is already in progress", vim.log.levels.WARN)
    return
  end

  vim.notify("0x0: Creating snapshot...", vim.log.levels.INFO)

  vim.cmd("silent! wall")

  snapshot.create(function(err, stash_ref)
    if err then
      vim.notify("0x0: Snapshot failed: " .. err, vim.log.levels.ERROR)
      return
    end

    _state = {
      bufnr = opts.bufnr,
      filepath = opts.filepath,
      stash_ref = stash_ref,
      provider = opts.provider,
      session_id = opts.session_id,
      on_session = opts.on_session,
      active = true,
    }

    local cfg = config.current
    local body = {
      prompt = opts.prompt,
      cwd = vim.fn.getcwd(),
      max_turns = cfg.max_turns,
    }
    if opts.append_system_prompt then
      body.append_system_prompt = opts.append_system_prompt
    end
    if opts.provider or cfg.provider then
      body.provider = opts.provider or cfg.provider
    end
    if opts.session_id then
      body.session_id = opts.session_id
    end
    if cfg.model then
      body.model = cfg.model
    end
    if cfg.permission_mode then
      body.permission_mode = cfg.permission_mode
    end

    vim.notify("0x0: Agent working...", vim.log.levels.INFO)

    local tool_log = {}

    _state.abort_fn = transport.stream_message(body, {
      on_init = function(event)
        if _state and event.session_id then
          _state.session_id = event.session_id
          if _state.on_session then
            _state.on_session(event.session_id, _state.provider or body.provider or "unknown")
          end
        end
      end,

      on_tool_use = function(event)
        table.insert(tool_log, event.name .. (event.input and " " or ""))
        local msg = "0x0: " .. event.name
        if event.input and type(event.input) == "table" and event.input.path then
          msg = msg .. " " .. event.input.path
        end
        vim.notify(msg, vim.log.levels.INFO)
      end,

      on_error = function(error_msg)
        vim.notify("0x0: Error — " .. error_msg, vim.log.levels.ERROR)
        M._cleanup_state()
      end,

      on_done = function()
        if not _state or not _state.active then
          return
        end

        vim.notify("0x0: Agent done. Computing diff...", vim.log.levels.INFO)

        vim.cmd("checktime")

        vim.defer_fn(function()
          M._compute_and_review()
        end, 200)
      end,

      on_result = function(event)
        if event.is_error then
          vim.notify("0x0: Agent error — " .. (event.result or "unknown"), vim.log.levels.ERROR)
          M._cleanup_state()
        end
      end,
    }, build_nvim_context(opts))
  end)
end

--- Start an edit session.
---@param opts { bufnr: integer, start_line: integer, end_line: integer }
function M.start(opts)
  local bufnr = opts.bufnr
  local filepath = vim.api.nvim_buf_get_name(bufnr)
  if filepath == "" then
    vim.notify("0x0: Buffer has no file", vim.log.levels.ERROR)
    return
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, opts.start_line - 1, opts.end_line, false)
  local selected_code = table.concat(lines, "\n")
  local rel_path = util.relative_path(filepath)
  local filetype = vim.bo[bufnr].filetype

  vim.ui.input({ prompt = "0x0 edit> " }, function(instruction)
    if not instruction or instruction == "" then
      return
    end

    require("zeroxzero.session").ensure_target(function(target)
      if not target then
        return
      end

      local prompt = string.format(
        "File: %s, lines %d-%d\nLanguage: %s\n\n```%s\n%s\n```\n\nInstruction: %s",
        rel_path,
        opts.start_line,
        opts.end_line,
        filetype,
        filetype,
        selected_code,
        instruction
      )

      M.run({
        prompt = prompt,
        append_system_prompt = "Focus on editing the specified code. Make minimal, targeted changes.",
        provider = target.provider,
        session_id = target.id,
        bufnr = bufnr,
        filepath = filepath,
        nvim_context = {
          selection = {
            filepath = filepath,
            relative_path = rel_path,
            filetype = filetype,
            start_line = opts.start_line,
            end_line = opts.end_line,
            lines = lines,
          },
        },
        on_session = function(session_id, provider)
          require("zeroxzero.session").remember(session_id, provider)
        end,
      })
    end)
  end)
end

--- Compute diff and start review after agent completes.
function M._compute_and_review()
  if not _state then
    return
  end

  diff.compute_from_git(_state.stash_ref, function(err, file_diffs)
    if err then
      vim.notify("0x0: Diff failed: " .. err, vim.log.levels.ERROR)
      M._cleanup_state()
      return
    end

    if not file_diffs or #file_diffs == 0 then
      vim.notify("0x0: No file changes detected", vim.log.levels.INFO)
      M._cleanup_state()
      return
    end

    -- Show summary
    local total_hunks = 0
    for _, fd in ipairs(file_diffs) do
      total_hunks = total_hunks + #fd.hunks
    end
    vim.notify(string.format("0x0: %d file(s), %d hunk(s) to review", #file_diffs, total_hunks), vim.log.levels.INFO)

    -- Review files one at a time
    M._review_files(file_diffs, 1)
  end)
end

--- Review files sequentially.
---@param file_diffs zeroxzero.FileDiff[]
---@param index integer
function M._review_files(file_diffs, index)
  if not _state then
    return
  end

  if index > #file_diffs then
    vim.notify("0x0: Review complete", vim.log.levels.INFO)
    M._cleanup_state()
    return
  end

  local fd = file_diffs[index]

  if #fd.hunks == 0 then
    M._review_files(file_diffs, index + 1)
    return
  end

  vim.notify(
    string.format("0x0: Reviewing %s (%d hunk%s)", fd.filepath, #fd.hunks, #fd.hunks == 1 and "" or "s"),
    vim.log.levels.INFO
  )

  -- Open the file
  local abs_path = vim.fn.getcwd() .. "/" .. fd.filepath
  vim.cmd("edit " .. vim.fn.fnameescape(abs_path))
  local bufnr = vim.api.nvim_get_current_buf()

  review.start({
    bufnr = bufnr,
    filepath = fd.filepath,
    file_status = fd.status,
    hunks = fd.hunks,
    stash_ref = _state.stash_ref,
    on_complete = function(accepted, rejected)
      M._persist_review_result(fd, bufnr, accepted, rejected)
      M._review_files(file_diffs, index + 1)
    end,
  })
end

---@param fd zeroxzero.FileDiff
---@param bufnr integer
---@param accepted zeroxzero.Hunk[]
---@param rejected zeroxzero.Hunk[]
function M._persist_review_result(fd, bufnr, accepted, rejected)
  local abs_path = vim.fn.getcwd() .. "/" .. fd.filepath

  if fd.status == "deleted" and #rejected == 0 then
    os.remove(abs_path)
    return
  end

  if fd.status == "added" and #accepted == 0 then
    os.remove(abs_path)
    return
  end

  if vim.api.nvim_buf_is_valid(bufnr) then
    vim.cmd("silent! noautocmd write!")
  end
end

--- Abort the current edit session.
function M.abort()
  if not _state then
    vim.notify("0x0: No active edit", vim.log.levels.WARN)
    return
  end

  local stash_ref = _state.stash_ref

  -- Abort streaming if still running
  if _state.abort_fn then
    _state.abort_fn()
  end

  -- Clean up review UI
  if review.is_active() then
    review.cleanup()
  end

  -- Restore all files from snapshot
  if stash_ref then
    vim.notify("0x0: Restoring files from snapshot...", vim.log.levels.INFO)
    snapshot.get_changed_files(stash_ref, function(err, files)
      if err or not files then
        vim.notify("0x0: Could not determine changed files", vim.log.levels.WARN)
        return
      end
      local remaining = #files
      if remaining == 0 then
        vim.notify("0x0: No files to restore", vim.log.levels.INFO)
        return
      end
      for _, f in ipairs(files) do
        snapshot.restore_file(stash_ref, f, function(restore_err)
          remaining = remaining - 1
          if restore_err then
            vim.notify("0x0: Failed to restore " .. f, vim.log.levels.WARN)
          end
          if remaining == 0 then
            vim.cmd("checktime")
            vim.notify("0x0: All files restored", vim.log.levels.INFO)
          end
        end)
      end
    end)
  end

  M._cleanup_state()
end

--- Clean up internal state without restoring files.
function M._cleanup_state()
  if _state then
    _state.active = false
  end
  _state = nil
end

--- Check if an edit is in progress.
---@return boolean
function M.is_active()
  return _state ~= nil and _state.active
end

return M
