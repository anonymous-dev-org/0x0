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

vim.api.nvim_create_user_command("ZeroSession", function()
  require("zeroxzero").select_session()
end, { desc = "0x0: Select active Claude/Codex session" })

vim.api.nvim_create_user_command("ZeroChat", function()
  require("zeroxzero").chat()
end, { desc = "0x0: Send a chat prompt to the active session" })

vim.api.nvim_create_user_command("ZeroContext", function()
  require("zeroxzero").add_context()
end, { desc = "0x0: Queue the current file as chat context" })

vim.api.nvim_create_user_command("ZeroContextVisual", function()
  require("zeroxzero").add_context_visual()
end, { range = true, desc = "0x0: Queue the current selection as chat context" })

vim.api.nvim_create_user_command("ZeroContextClear", function()
  require("zeroxzero").clear_context()
end, { desc = "0x0: Clear queued chat context" })

vim.api.nvim_create_user_command("ZeroAbort", function()
  require("zeroxzero").abort()
end, { desc = "0x0: Abort current edit and restore files" })
