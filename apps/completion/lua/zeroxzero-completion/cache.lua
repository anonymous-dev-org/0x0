--- LRU cache for completion results with prefix-match shifting.
--- When the user types a character that matches the start of a cached completion,
--- the completion is shifted by one character and reused without a server round-trip.

local M = {}

---@class zeroxzero_completion.CacheEntry
---@field key string
---@field completion string
---@field timestamp number

---@type zeroxzero_completion.CacheEntry[]
local _entries = {}
local _max_entries = 100

--- Initialize the cache with a max size.
---@param max_entries integer
function M.init(max_entries)
  _max_entries = max_entries or 100
  _entries = {}
end

--- Generate a cache key from context.
---@param prefix string
---@param suffix string
---@param language string
---@return string
function M.make_key(prefix, suffix, language)
  -- Use last 200 chars of prefix + first 200 chars of suffix + language
  local p = prefix:sub(-200)
  local s = suffix:sub(1, 200)
  return p .. "\0" .. s .. "\0" .. language
end

--- Get a cached completion.
---@param key string
---@return string?
function M.get(key)
  for _, entry in ipairs(_entries) do
    if entry.key == key then
      entry.timestamp = vim.uv.now()
      return entry.completion
    end
  end
  return nil
end

--- Store a completion in the cache.
---@param key string
---@param completion string
function M.set(key, completion)
  -- Check if key already exists
  for i, entry in ipairs(_entries) do
    if entry.key == key then
      entry.completion = completion
      entry.timestamp = vim.uv.now()
      return
    end
  end

  -- Add new entry
  table.insert(_entries, {
    key = key,
    completion = completion,
    timestamp = vim.uv.now(),
  })

  -- Evict oldest if over max
  if #_entries > _max_entries then
    local oldest_idx = 1
    local oldest_time = _entries[1].timestamp
    for i = 2, #_entries do
      if _entries[i].timestamp < oldest_time then
        oldest_idx = i
        oldest_time = _entries[i].timestamp
      end
    end
    table.remove(_entries, oldest_idx)
  end
end

--- Try to shift a cached completion by matching a typed character.
--- If the cached completion starts with the character, return the rest.
---@param old_key string Previous cache key
---@param typed_char string The character the user just typed
---@return string? shifted_completion The remaining completion text, or nil
function M.try_shift(old_key, typed_char)
  local completion = M.get(old_key)
  if not completion then
    return nil
  end

  if completion:sub(1, #typed_char) == typed_char then
    local shifted = completion:sub(#typed_char + 1)
    if shifted ~= "" then
      return shifted
    end
  end

  return nil
end

--- Clear all cached entries.
function M.clear()
  _entries = {}
end

return M
