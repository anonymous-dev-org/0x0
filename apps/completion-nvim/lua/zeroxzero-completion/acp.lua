--- Minimal ACP client for inline completion.
--- Spawns an ACP provider directly so completions do not require the 0x0 server.

local M = {}

local uv = vim.uv or vim.loop

local client = nil

local function completion_prompt(request)
  return table.concat({
    "You are an inline code completion engine.",
    "Complete the code at the cursor. Return only the text that should be inserted.",
    "Do not include markdown fences, explanations, or surrounding unchanged text.",
    "",
    "File: " .. tostring(request.filepath or ""),
    "Language: " .. tostring(request.language or ""),
    "",
    "<prefix>",
    request.prefix or "",
    "</prefix>",
    "",
    "<suffix>",
    request.suffix or "",
    "</suffix>",
  }, "\n")
end

local function choose_permission_option(options)
  for _, wanted in ipairs({ "reject_once", "reject_always", "allow_once", "allow_always" }) do
    for _, option in ipairs(options or {}) do
      if option.kind == wanted then
        return option
      end
    end
  end
end

local AcpClient = {}
AcpClient.__index = AcpClient

function AcpClient:new(config)
  local instance = setmetatable({
    config = config,
    id = 0,
    callbacks = {},
    subscribers = {},
    ready = false,
    ready_callbacks = {},
    stopped = false,
    buffer = "",
  }, self)
  instance:start()
  return instance
end

function AcpClient:next_id()
  self.id = self.id + 1
  return self.id
end

function AcpClient:send(message)
  if not self.stdin or self.stdin:is_closing() then
    return false
  end
  self.stdin:write(vim.json.encode(message) .. "\n")
  return true
end

function AcpClient:request(method, params, callback)
  local id = self:next_id()
  self.callbacks[id] = callback
  self:send({
    jsonrpc = "2.0",
    id = id,
    method = method,
    params = params or {},
  })
  return id
end

function AcpClient:respond(id, result)
  self:send({
    jsonrpc = "2.0",
    id = id,
    result = result,
  })
end

function AcpClient:start()
  local stdin = uv.new_pipe(false)
  local stdout = uv.new_pipe(false)
  local stderr = uv.new_pipe(false)
  if not stdin or not stdout or not stderr then
    error("Failed to create ACP stdio pipes")
  end

  local env_map = vim.fn.environ()
  env_map.NODE_NO_WARNINGS = "1"
  env_map.IS_AI_TERMINAL = "1"
  local env = {}
  for key, value in pairs(env_map) do
    env[#env + 1] = key .. "=" .. value
  end

  local handle
  handle = uv.spawn(self.config.command, {
    args = self.config.args or {},
    env = env,
    stdio = { stdin, stdout, stderr },
    detached = false,
  }, function(code)
    self.ready = false
    self.stopped = true
    for _, callback in pairs(self.callbacks) do
      vim.schedule(function()
        callback(nil, { message = "ACP process exited with code " .. tostring(code) })
      end)
    end
    self.callbacks = {}
    self.subscribers = {}
    if handle and not handle:is_closing() then
      handle:close()
    end
  end)

  if not handle then
    error("Failed to spawn ACP command: " .. tostring(self.config.command))
  end

  self.process = handle
  self.stdin = stdin
  self.stdout = stdout
  self.stderr = stderr

  stdout:read_start(function(err, data)
    if err then
      return
    end
    if data then
      self:on_stdout(data)
    end
  end)

  stderr:read_start(function() end)

  self:initialize()
end

function AcpClient:initialize()
  self:request("initialize", {
    protocolVersion = 1,
    clientInfo = {
      name = "0x0-completion.nvim",
      version = "0.1.0",
    },
    clientCapabilities = {
      fs = {
        readTextFile = false,
        writeTextFile = false,
      },
      terminal = false,
    },
  }, function(_, err)
    if err then
      return
    end

    if self.config.auth_method then
      self:request("authenticate", { methodId = self.config.auth_method }, function()
        self:mark_ready()
      end)
      return
    end

    self:mark_ready()
  end)
end

function AcpClient:mark_ready()
  self.ready = true
  local callbacks = self.ready_callbacks
  self.ready_callbacks = {}
  for _, callback in ipairs(callbacks) do
    vim.schedule(callback)
  end
end

function AcpClient:when_ready(callback)
  if self.ready then
    vim.schedule(callback)
    return
  end
  self.ready_callbacks[#self.ready_callbacks + 1] = callback
end

function AcpClient:on_stdout(data)
  self.buffer = self.buffer .. data
  local lines = vim.split(self.buffer, "\n", { plain = true })
  self.buffer = lines[#lines]

  for i = 1, #lines - 1 do
    local line = vim.trim(lines[i])
    if line ~= "" then
      local ok, message = pcall(vim.json.decode, line)
      if ok and type(message) == "table" then
        self:on_message(message)
      end
    end
  end
end

function AcpClient:on_message(message)
  if message.id and (message.result ~= nil or message.error ~= nil) then
    local callback = self.callbacks[message.id]
    if callback then
      self.callbacks[message.id] = nil
      callback(message.result, message.error)
    end
    return
  end

  if message.method == "session/update" and message.params then
    local subscriber = self.subscribers[message.params.sessionId]
    if subscriber then
      subscriber(message.params.update or {})
    end
    return
  end

  if message.method == "session/request_permission" and message.id then
    local option = choose_permission_option(message.params and message.params.options)
    if option and option.kind:match("^allow") then
      self:respond(message.id, { outcome = { outcome = "selected", optionId = option.optionId } })
    else
      self:respond(message.id, { outcome = { outcome = "cancelled" } })
    end
  end
end

function AcpClient:create_session(request, on_chunk, on_done)
  self:request("session/new", {
    cwd = vim.fn.getcwd(),
    mcpServers = {},
  }, function(result, err)
    if err then
      on_done(err.message or vim.inspect(err))
      return
    end

    local session_id = result and result.sessionId
    if not session_id then
      on_done("ACP session/new returned no sessionId")
      return
    end

    self.subscribers[session_id] = function(update)
      if update.sessionUpdate ~= "agent_message_chunk" then
        return
      end
      local content = update.content
      if type(content) == "table" and content.type == "text" and content.text then
        on_chunk(content.text)
      end
    end

    local function prompt()
      self:request("session/prompt", {
        sessionId = session_id,
        prompt = {
          {
            type = "text",
            text = completion_prompt(request),
          },
        },
      }, function(_, prompt_err)
        self.subscribers[session_id] = nil
        on_done(prompt_err and (prompt_err.message or vim.inspect(prompt_err)) or nil)
      end)
    end

    if request.model then
      self:request("session/set_model", {
        sessionId = session_id,
        modelId = request.model,
      }, function()
        prompt()
      end)
    else
      prompt()
    end
  end)
end

function AcpClient:cancel(session_id)
  if session_id then
    self:request("session/cancel", { sessionId = session_id }, function() end)
  end
end

function AcpClient:stop()
  self.ready = false
  self.stopped = true
  if self.stdout and not self.stdout:is_closing() then
    self.stdout:read_stop()
  end
  if self.stderr and not self.stderr:is_closing() then
    self.stderr:read_stop()
  end
  if self.process and not self.process:is_closing() then
    self.process:kill()
  end
end

local function get_client(config)
  if client and not client.stopped then
    return client
  end
  client = AcpClient:new(config)
  return client
end

--- Send a streaming completion request over ACP.
---@param acp_config zeroxzero_completion.AcpConfig
---@param request zeroxzero_completion.Request
---@param on_chunk fun(text: string)
---@param on_done fun(err?: string)
---@return fun() abort function
function M.stream_completion(acp_config, request, on_chunk, on_done)
  local active = true
  local active_session_id = nil
  local acp = get_client(acp_config)

  acp:when_ready(function()
    if not active then
      return
    end
    acp:create_session(request, function(chunk)
      if active then
        vim.schedule(function()
          on_chunk(chunk)
        end)
      end
    end, function(err)
      if active then
        vim.schedule(function()
          on_done(err)
        end)
      end
    end)
  end)

  return function()
    active = false
    acp:cancel(active_session_id)
  end
end

function M.close()
  if client then
    client:stop()
    client = nil
  end
end

return M
