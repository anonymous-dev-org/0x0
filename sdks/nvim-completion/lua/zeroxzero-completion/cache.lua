local M = {}

---@type string[]
local keys = {}
---@type table<string, string>
local entries = {}
---@type number
local max_size = 64

---@param size number
function M.setup(size)
  max_size = size
end

---@param key string
---@return string?
function M.get(key)
  return entries[key]
end

---@param key string
---@param value string
function M.set(key, value)
  if entries[key] then
    -- Move to end (most recent)
    for i, k in ipairs(keys) do
      if k == key then
        table.remove(keys, i)
        break
      end
    end
  elseif #keys >= max_size then
    -- Evict oldest
    local old = table.remove(keys, 1)
    entries[old] = nil
  end
  table.insert(keys, key)
  entries[key] = value
end

function M.clear()
  keys = {}
  entries = {}
end

return M
