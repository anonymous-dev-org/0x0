local M = {}

---@param opts? table
function M.setup(opts)
  local config = require("zeroxzero-completion.config")
  config.setup(opts)

  local completion = require("zeroxzero-completion.completion")
  completion.setup_triggers()

  -- Register keymaps
  local keymaps = config.current.keymaps

  -- Tab: accept completion or fall through
  vim.keymap.set("i", keymaps.accept, function()
    if completion.accept() then
      return ""
    end
    -- Fall through to original Tab behavior
    return vim.api.nvim_replace_termcodes(keymaps.accept, true, false, true)
  end, { expr = true, silent = true, desc = "Accept 0x0 completion or fall through" })

  -- Dismiss
  vim.keymap.set("i", keymaps.dismiss, function()
    completion.dismiss()
  end, { silent = true, desc = "Dismiss 0x0 completion" })

  -- Accept word
  vim.keymap.set("i", keymaps.accept_word, function()
    completion.accept_word()
  end, { silent = true, desc = "Accept word from 0x0 completion" })

  -- Accept line
  vim.keymap.set("i", keymaps.accept_line, function()
    completion.accept_line()
  end, { silent = true, desc = "Accept line from 0x0 completion" })

  -- Toggle
  vim.keymap.set("n", keymaps.toggle, function()
    completion.toggle()
  end, { silent = true, desc = "Toggle 0x0 completion" })
end

return M
