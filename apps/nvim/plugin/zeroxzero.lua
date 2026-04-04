--- 0x0-nvim plugin loader.
--- Defines vim commands for the plugin.

if vim.g.loaded_zeroxzero then
  return
end
vim.g.loaded_zeroxzero = true

vim.api.nvim_create_user_command("ZeroEdit", function()
  require("zeroxzero").edit()
end, { desc = "0x0: Edit code with AI (treesitter scope)" })

vim.api.nvim_create_user_command("ZeroEditVisual", function()
  require("zeroxzero").edit_visual()
end, { range = true, desc = "0x0: Edit selection with AI" })

vim.api.nvim_create_user_command("ZeroAbort", function()
  require("zeroxzero").abort()
end, { desc = "0x0: Abort current edit and restore files" })
