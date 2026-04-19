--- Transport abstraction for server-backed and native provider execution.

local api = require("zeroxzero.api")
local config = require("zeroxzero.config")
local registry = require("zeroxzero.native.registry")

local M = {}

local function use_native()
  return config.current.transport == "native"
end

local function native_provider_list()
  local providers = {}
  if vim.fn.executable("claude") == 1 then
    table.insert(providers, { id = "claude", name = "Claude" })
  end
  if vim.fn.executable("codex") == 1 then
    table.insert(providers, { id = "codex", name = "Codex" })
  end
  return providers
end

---@param body table
---@param callbacks zeroxzero.StreamCallbacks
---@param nvim_context? table
---@return fun()
function M.stream_message(body, callbacks, nvim_context)
  if not use_native() then
    return api.stream_message(config.current.server_url, body, callbacks)
  end

  if body.provider == "claude" then
    return require("zeroxzero.native.claude").stream({
      prompt = body.prompt,
      session_id = body.session_id,
      model = body.model,
      effort = body.effort,
      cwd = body.cwd,
      append_system_prompt = body.append_system_prompt,
      max_turns = body.max_turns,
      nvim_context = nvim_context,
    }, callbacks)
  end

  if body.provider == "codex" then
    return require("zeroxzero.native.codex").stream({
      prompt = body.prompt,
      session_id = body.session_id,
      model = body.model,
      cwd = body.cwd,
      sandbox = body.sandbox,
    }, callbacks)
  end

  vim.schedule(function()
    if callbacks.on_error then
      callbacks.on_error("Unsupported native provider: " .. tostring(body.provider))
    end
  end)
  return function() end
end

---@param callback fun(err?: string, providers?: table[])
function M.list_providers(callback)
  if use_native() then
    callback(nil, native_provider_list())
    return
  end
  api.list_providers(config.current.server_url, callback)
end

---@param callback fun(err?: string, sessions?: table[])
function M.list_sessions(callback)
  if use_native() then
    callback(nil, registry.list())
    return
  end
  api.list_sessions(config.current.server_url, callback)
end

---@param session { id: string, provider: string, label?: string }
function M.remember_session(session)
  if use_native() then
    registry.upsert(session)
  end
end

return M
