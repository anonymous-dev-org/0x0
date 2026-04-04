--- HTTP client for the 0x0 server.
--- Handles streaming SSE requests via curl and non-streaming requests.

local stream = require("zeroxzero.stream")

local M = {}

---@class zeroxzero.StreamCallbacks
---@field on_init? fun(event: table)
---@field on_text_delta? fun(text: string)
---@field on_tool_use? fun(event: table)
---@field on_tool_result? fun(event: table)
---@field on_result? fun(event: table)
---@field on_done? fun()
---@field on_error? fun(error: string)

--- Send a streaming message to the 0x0 server.
---@param server_url string
---@param body table Request body for POST /messages
---@param callbacks zeroxzero.StreamCallbacks
---@return fun() abort function
function M.stream_message(server_url, body, callbacks)
  body.stream = true

  local parse = stream.create_parser(function(event)
    vim.schedule(function()
      local t = event.type
      if t == "init" and callbacks.on_init then
        callbacks.on_init(event)
      elseif t == "text_delta" and callbacks.on_text_delta then
        callbacks.on_text_delta(event.text)
      elseif t == "tool_use" and callbacks.on_tool_use then
        callbacks.on_tool_use(event)
      elseif t == "tool_result" and callbacks.on_tool_result then
        callbacks.on_tool_result(event)
      elseif t == "result" and callbacks.on_result then
        callbacks.on_result(event)
      elseif t == "done" and callbacks.on_done then
        callbacks.on_done()
      elseif t == "error" and callbacks.on_error then
        callbacks.on_error(event.error or "unknown error")
      end
    end)
  end)

  local json_body = vim.json.encode(body)

  local job_id = vim.fn.jobstart({
    "curl",
    "-s",
    "-N",
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: text/event-stream",
    "-X",
    "POST",
    "-d",
    json_body,
    server_url .. "/messages",
  }, {
    on_stdout = function(_, data)
      if data then
        for _, line in ipairs(data) do
          if line ~= "" then
            parse(line .. "\n")
          end
        end
      end
    end,
    on_stderr = function(_, data)
      if data and callbacks.on_error then
        local msg = table.concat(data, "\n")
        if msg ~= "" then
          vim.schedule(function()
            callbacks.on_error("curl error: " .. msg)
          end)
        end
      end
    end,
    on_exit = function(_, code)
      if code ~= 0 and callbacks.on_error then
        vim.schedule(function()
          callbacks.on_error("curl exited with code " .. code)
        end)
      end
    end,
    stdout_buffered = false,
  })

  if job_id <= 0 then
    vim.schedule(function()
      if callbacks.on_error then
        callbacks.on_error("Failed to start curl")
      end
    end)
    return function() end
  end

  return function()
    vim.fn.jobstop(job_id)
  end
end

--- Check if the 0x0 server is healthy.
---@param server_url string
---@param callback fun(ok: boolean)
function M.health(server_url, callback)
  vim.fn.jobstart({ "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", server_url .. "/health" }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      local code = data and data[1]
      vim.schedule(function()
        callback(code == "200")
      end)
    end,
    on_exit = function(_, exit_code)
      if exit_code ~= 0 then
        vim.schedule(function()
          callback(false)
        end)
      end
    end,
  })
end

return M
