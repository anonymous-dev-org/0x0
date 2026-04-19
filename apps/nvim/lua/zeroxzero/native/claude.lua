--- Native Claude transport using the local Claude CLI plus a Neovim MCP bridge.

local paths = require("zeroxzero.native.paths")

local M = {}

local function as_record(value)
  if type(value) ~= "table" then
    return nil
  end
  return value
end

local function write_json_file(path, value)
  vim.fn.writefile(vim.split(vim.json.encode(value), "\n", { plain = true }), path)
end

local function build_mcp_config()
  local config = {
    mcpServers = {
      ["0x0-nvim"] = {
        command = "bun",
        args = { "run", paths.nvim_mcp_server_path() },
        env = {
          ZEROXZERO_NVIM_STATE = paths.nvim_state_path(),
        },
      },
    },
  }

  write_json_file(paths.claude_mcp_config_path(), config)
  return paths.claude_mcp_config_path()
end

---@param opts { prompt: string, provider?: string, session_id?: string, model?: string, effort?: string, cwd?: string, append_system_prompt?: string, max_turns?: integer, nvim_context?: table }
---@param callbacks zeroxzero.StreamCallbacks
---@return fun()
function M.stream(opts, callbacks)
  write_json_file(paths.nvim_state_path(), opts.nvim_context or {})
  local mcp_config = build_mcp_config()

  local args = {
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  }

  if opts.session_id then
    table.insert(args, "--resume")
    table.insert(args, opts.session_id)
  end
  if opts.model then
    table.insert(args, "--model")
    table.insert(args, opts.model)
  end
  if opts.effort then
    table.insert(args, "--effort")
    table.insert(args, opts.effort)
  end
  if opts.max_turns then
    table.insert(args, "--max-turns")
    table.insert(args, tostring(opts.max_turns))
  end
  if opts.append_system_prompt then
    table.insert(args, "--append-system-prompt")
    table.insert(args, opts.append_system_prompt)
  end

  table.insert(args, opts.prompt)
  table.insert(args, "--mcp-config")
  table.insert(args, mcp_config)

  local pending_tool_uses = {}
  local decoder_buffer = ""
  local finished = false

  local function flush_line(line)
    local ok, msg = pcall(vim.json.decode, line)
    if not ok or type(msg) ~= "table" then
      return
    end

    if msg.type == "system" and msg.subtype == "init" then
      if callbacks.on_init then
        callbacks.on_init({ session_id = msg.session_id })
      end
      return
    end

    if msg.type == "stream_event" then
      local event = as_record(msg.event)
      if not event then
        return
      end

      if event.type == "content_block_start" then
        local block = as_record(event.content_block)
        if block and block.type == "tool_use" and type(event.index) == "number" then
          pending_tool_uses[event.index] = {
            id = block.id,
            name = block.name or "unknown",
            partial_json = "",
            input = block.input,
          }
        end
        return
      end

      if event.type == "content_block_delta" then
        local delta = as_record(event.delta)
        if not delta then
          return
        end

        if delta.type == "text_delta" and callbacks.on_text_delta then
          callbacks.on_text_delta(delta.text or "")
          return
        end

        if delta.type == "input_json_delta" and type(event.index) == "number" then
          local pending = pending_tool_uses[event.index]
          if pending then
            pending.partial_json = pending.partial_json .. (delta.partial_json or "")
          end
        end
        return
      end

      if event.type == "content_block_stop" and type(event.index) == "number" then
        local pending = pending_tool_uses[event.index]
        pending_tool_uses[event.index] = nil
        if pending and callbacks.on_tool_use then
          local input = pending.input
          if pending.partial_json ~= "" then
            local parsed_ok, parsed = pcall(vim.json.decode, pending.partial_json)
            if parsed_ok then
              input = parsed
            end
          end
          callbacks.on_tool_use({
            id = pending.id,
            name = pending.name,
            input = input,
          })
        end
        return
      end
    end

    if msg.type == "user" then
      local message = as_record(msg.message)
      local content = message and message.content or nil
      if type(content) == "table" then
        for _, item in ipairs(content) do
          if type(item) == "table" and item.type == "tool_result" and callbacks.on_tool_result then
            callbacks.on_tool_result({
              tool_use_id = item.tool_use_id,
              content = msg.tool_use_result or item.content,
            })
          end
        end
      end
      return
    end

    if msg.type == "result" then
      if callbacks.on_result then
        callbacks.on_result({
          session_id = msg.session_id,
          result = msg.result,
          cost_usd = msg.cost_usd,
          duration_ms = msg.duration_ms,
          is_error = msg.is_error,
        })
      end
      return
    end

    if msg.type == "error" and callbacks.on_error then
      callbacks.on_error(msg.message or "Claude stream error")
    end
  end

  local job_id = vim.fn.jobstart(args, {
    cwd = opts.cwd,
    stdout_buffered = false,
    on_stdout = function(_, data)
      for _, chunk in ipairs(data or {}) do
        decoder_buffer = decoder_buffer .. chunk .. "\n"
        while true do
          local idx = decoder_buffer:find("\n")
          if not idx then
            break
          end
          local line = decoder_buffer:sub(1, idx - 1)
          decoder_buffer = decoder_buffer:sub(idx + 1)
          if line ~= "" then
            vim.schedule(function()
              flush_line(line)
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
      if finished then
        return
      end
      finished = true
      vim.schedule(function()
        if code == 0 then
          if callbacks.on_done then
            callbacks.on_done()
          end
        elseif callbacks.on_error then
          callbacks.on_error("claude exited with code " .. code)
        end
      end)
    end,
  })

  if job_id <= 0 then
    vim.schedule(function()
      if callbacks.on_error then
        callbacks.on_error("Failed to start claude")
      end
    end)
    return function() end
  end

  return function()
    finished = true
    vim.fn.jobstop(job_id)
  end
end

return M
