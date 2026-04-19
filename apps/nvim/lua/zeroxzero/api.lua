--- HTTP client for the 0x0 server.
--- Handles streaming SSE requests via curl and JSON REST helpers.

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
          parse((line or "") .. "\n")
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

---@param server_url string
---@param method string
---@param path string
---@param body? table
---@param callback fun(err?: string, response?: { status: integer, body: any, raw_body: string })
function M.request_json(server_url, method, path, body, callback)
  local args = {
    "curl",
    "-s",
    "-X",
    method,
    "-H",
    "Accept: application/json",
    "-w",
    "\n%{http_code}",
  }

  if body ~= nil then
    table.insert(args, "-H")
    table.insert(args, "Content-Type: application/json")
    table.insert(args, "-d")
    table.insert(args, vim.json.encode(body))
  end

  table.insert(args, server_url .. path)

  vim.fn.jobstart(args, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      vim.schedule(function()
        local output = table.concat(data or {}, "\n")
        local raw_body, status_text = output:match("^(.*)\n(%d%d%d)$")
        if not status_text then
          callback("unexpected response")
          return
        end

        local status = tonumber(status_text)
        local decoded = nil

        if raw_body ~= "" then
          local ok, parsed = pcall(vim.json.decode, raw_body)
          if not ok then
            callback("invalid json response")
            return
          end
          decoded = parsed
        end

        callback(nil, {
          status = status,
          body = decoded,
          raw_body = raw_body,
        })
      end)
    end,
    on_exit = function(_, exit_code)
      if exit_code ~= 0 then
        vim.schedule(function()
          callback("curl exited with code " .. exit_code)
        end)
      end
    end,
  })
end

---@param server_url string
---@param path string
---@param callback fun(err?: string, response?: { status: integer, body: any, raw_body: string })
function M.get_json(server_url, path, callback)
  M.request_json(server_url, "GET", path, nil, callback)
end

---@param server_url string
---@param path string
---@param body table
---@param callback fun(err?: string, response?: { status: integer, body: any, raw_body: string })
function M.post_json(server_url, path, body, callback)
  M.request_json(server_url, "POST", path, body, callback)
end

--- List available providers.
---@param server_url string
---@param callback fun(err?: string, providers?: table[])
function M.list_providers(server_url, callback)
  M.get_json(server_url, "/providers", function(err, response)
    if err then
      callback(err)
      return
    end
    if not response or response.status ~= 200 then
      callback("unexpected status " .. tostring(response and response.status))
      return
    end
    callback(nil, response.body and response.body.providers or {})
  end)
end

--- List known sessions.
---@param server_url string
---@param callback fun(err?: string, sessions?: table[])
function M.list_sessions(server_url, callback)
  M.get_json(server_url, "/sessions", function(err, response)
    if err then
      callback(err)
      return
    end
    if not response or response.status ~= 200 then
      callback("unexpected status " .. tostring(response and response.status))
      return
    end
    callback(nil, response.body and response.body.sessions or {})
  end)
end

--- Check if the 0x0 server is healthy.
---@param server_url string
---@param callback fun(ok: boolean)
function M.health(server_url, callback)
  M.get_json(server_url, "/health", function(err, response)
    callback(not err and response and response.status == 200 or false)
  end)
end

return M
