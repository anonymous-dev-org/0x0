--- Local session registry for native Claude/Codex sessions.

local paths = require("zeroxzero.native.paths")

local M = {}

local function load_registry()
  local path = paths.session_registry_path()
  local lines = vim.fn.readfile(path)
  if vim.v.shell_error ~= 0 or not lines or #lines == 0 then
    return { sessions = {} }
  end

  local ok, decoded = pcall(vim.json.decode, table.concat(lines, "\n"))
  if not ok or type(decoded) ~= "table" then
    return { sessions = {} }
  end

  decoded.sessions = decoded.sessions or {}
  return decoded
end

local function save_registry(registry)
  local path = paths.session_registry_path()
  vim.fn.writefile(vim.split(vim.json.encode(registry), "\n", { plain = true }), path)
end

---@return table[]
function M.list()
  return load_registry().sessions
end

---@param session { id: string, provider: string, label?: string, created_at?: string, last_active_at?: string }
function M.upsert(session)
  local registry = load_registry()
  local existing_index = nil

  for index, item in ipairs(registry.sessions) do
    if item.id == session.id and item.provider == session.provider then
      existing_index = index
      break
    end
  end

  local now = os.date("!%Y-%m-%dT%H:%M:%SZ")
  local next_session = {
    id = session.id,
    provider = session.provider,
    label = session.label,
    created_at = session.created_at or now,
    last_active_at = session.last_active_at or now,
  }

  if existing_index then
    local current = registry.sessions[existing_index]
    next_session.created_at = current.created_at or next_session.created_at
    if not next_session.label or next_session.label == "" then
      next_session.label = current.label
    end
    registry.sessions[existing_index] = next_session
  else
    table.insert(registry.sessions, 1, next_session)
  end

  table.sort(registry.sessions, function(a, b)
    return (a.last_active_at or "") > (b.last_active_at or "")
  end)

  save_registry(registry)
end

return M
