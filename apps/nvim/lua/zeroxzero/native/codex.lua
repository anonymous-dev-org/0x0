--- Native Codex transport using `codex app-server` over stdio JSON-RPC.

local M = {}

local function send(job_id, payload)
  vim.fn.chansend(job_id, vim.json.encode(payload) .. "\n")
end

---@param opts { prompt: string, session_id?: string, model?: string, cwd?: string, sandbox?: string }
---@param callbacks zeroxzero.StreamCallbacks
---@return fun()
function M.stream(opts, callbacks)
  local next_id = 0
  local pending = {}
  local buffer = ""
  local state = {
    thread_id = opts.session_id,
    turn_id = nil,
    done = false,
    did_init = false,
  }

  local function request(job_id, method, params, cb)
    next_id = next_id + 1
    pending[next_id] = cb
    send(job_id, {
      id = next_id,
      method = method,
      params = params,
    })
  end

  local function handle_notification(job_id, message)
    local method = message.method
    local params = message.params or {}

    if method == "thread/started" then
      local thread = params.thread or {}
      state.thread_id = thread.id
      if callbacks.on_init and not state.did_init then
        state.did_init = true
        callbacks.on_init({ session_id = state.thread_id })
      end
      return
    end

    if method == "turn/started" then
      local turn = params.turn or {}
      state.turn_id = turn.id
      return
    end

    if method == "item/agentMessage/delta" and callbacks.on_text_delta then
      callbacks.on_text_delta(params.delta or "")
      return
    end

    if method == "item/started" and callbacks.on_tool_use then
      local item = params.item or {}
      if item.type == "commandExecution" then
        callbacks.on_tool_use({
          id = item.id,
          name = "command_execution",
          input = { command = item.command, cwd = item.cwd },
        })
      elseif item.type == "fileChange" then
        callbacks.on_tool_use({
          id = item.id,
          name = "file_change",
          input = { changes = item.changes },
        })
      end
      return
    end

    if method == "item/completed" and callbacks.on_tool_result then
      local item = params.item or {}
      if item.type == "commandExecution" then
        callbacks.on_tool_result({
          tool_use_id = item.id,
          content = {
            command = item.command,
            aggregated_output = item.aggregatedOutput,
            exit_code = item.exitCode,
            status = item.status,
          },
        })
      elseif item.type == "fileChange" then
        callbacks.on_tool_result({
          tool_use_id = item.id,
          content = {
            status = item.status,
            changes = item.changes,
          },
        })
      end
      return
    end

    if method == "turn/completed" then
      state.done = true
      if callbacks.on_result then
        callbacks.on_result({
          session_id = state.thread_id,
          result = "",
        })
      end
      if callbacks.on_done then
        callbacks.on_done()
      end
      vim.fn.jobstop(job_id)
      return
    end

    if method == "error" and callbacks.on_error then
      callbacks.on_error(params.message or "Codex app-server error")
    end
  end

  local job_id = vim.fn.jobstart({ "codex", "app-server", "--listen", "stdio://" }, {
    stdout_buffered = false,
    on_stdout = function(_, data)
      for _, chunk in ipairs(data or {}) do
        buffer = buffer .. chunk .. "\n"
        while true do
          local idx = buffer:find("\n")
          if not idx then
            break
          end
          local line = buffer:sub(1, idx - 1)
          buffer = buffer:sub(idx + 1)
          if line ~= "" then
            vim.schedule(function()
              local ok, message = pcall(vim.json.decode, line)
              if not ok or type(message) ~= "table" then
                return
              end

              if message.id ~= nil then
                local cb = pending[message.id]
                pending[message.id] = nil
                if cb then
                  cb(message)
                end
              elseif message.method then
                handle_notification(job_id, message)
              end
            end)
          end
        end
      end
    end,
    on_stderr = function(_, data)
      local message = table.concat(data or {}, "\n")
      if message ~= "" and callbacks.on_error then
        vim.schedule(function()
          callbacks.on_error(message)
        end)
      end
    end,
    on_exit = function(_, code)
      if state.done then
        return
      end
      vim.schedule(function()
        if code ~= 0 and callbacks.on_error then
          callbacks.on_error("codex app-server exited with code " .. code)
        end
      end)
    end,
  })

  if job_id <= 0 then
    vim.schedule(function()
      if callbacks.on_error then
        callbacks.on_error("Failed to start codex app-server")
      end
    end)
    return function() end
  end

  request(job_id, "initialize", {
    clientInfo = { name = "0x0-nvim", version = "0.1.0" },
    capabilities = { experimentalApi = false },
  }, function()
    send(job_id, { method = "initialized" })

    local function start_turn()
      request(job_id, "turn/start", {
        threadId = state.thread_id,
        input = {
          {
            type = "text",
            text = opts.prompt,
            text_elements = {},
          },
        },
      }, function() end)
    end

    if state.thread_id then
      if callbacks.on_init and not state.did_init then
        state.did_init = true
        callbacks.on_init({ session_id = state.thread_id })
      end
      start_turn()
      return
    end

    request(job_id, "thread/start", {
      cwd = opts.cwd,
      model = opts.model,
      approvalPolicy = "never",
      sandbox = opts.sandbox or "workspace-write",
      experimentalRawEvents = false,
      persistExtendedHistory = false,
    }, function(response)
      local result = response.result or {}
      local thread = result.thread or {}
      state.thread_id = thread.id
      if callbacks.on_init and not state.did_init then
        state.did_init = true
        callbacks.on_init({ session_id = state.thread_id })
      end
      start_turn()
    end)
  end)

  return function()
    if state.turn_id and state.thread_id then
      request(job_id, "turn/interrupt", {
        threadId = state.thread_id,
        turnId = state.turn_id,
      }, function()
        vim.fn.jobstop(job_id)
      end)
      return
    end
    vim.fn.jobstop(job_id)
  end
end

return M
