local config = require("zeroxzero.config")

local M = {}

local function notify(text)
  vim.notify("0x0-chat: " .. text, vim.log.levels.INFO)
end

local function pick_provider(chat)
  local ids = {}
  for id in pairs(config.current.providers) do ids[#ids + 1] = id end
  table.sort(ids)

  vim.ui.select(ids, {
    prompt = "0x0 chat provider",
    format_item = function(id)
      local p = config.current.providers[id]
      return ("%s (%s)"):format(p.name or id, id)
    end,
  }, function(choice)
    if not choice then return end
    chat.set_provider(choice)
    notify("provider: " .. choice)
  end)
end

local function pick_model(chat)
  local current = chat.current_settings()
  local provider = config.current.providers[current.provider] or {}
  local models = provider.models or {}

  local choices = vim.deepcopy(models)
  choices[#choices + 1] = "(custom...)"
  choices[#choices + 1] = "(clear)"

  vim.ui.select(choices, {
    prompt = ("0x0 model for %s"):format(current.provider),
  }, function(choice)
    if not choice then return end
    if choice == "(clear)" then
      chat.set_model(nil)
      notify("model cleared")
      return
    end
    if choice == "(custom...)" then
      vim.ui.input({ prompt = "model id", default = current.model or "" }, function(value)
        if not value or value == "" then return end
        chat.set_model(value)
        notify("model: " .. value)
      end)
      return
    end
    chat.set_model(choice)
    notify("model: " .. choice)
  end)
end

function M.open()
  local chat = require("zeroxzero.chat")
  local current = chat.current_settings()

  local actions = {
    {
      label = "Provider: " .. tostring(current.provider),
      run = function() pick_provider(chat) end,
    },
    {
      label = "Model: " .. tostring(current.model or "provider default"),
      run = function() pick_model(chat) end,
    },
  }

  vim.ui.select(actions, {
    prompt = "0x0 chat settings",
    format_item = function(action) return action.label end,
  }, function(action)
    if action then action.run() end
  end)
end

return M
