--- 0x0-completion plugin loader.

if vim.g.loaded_zeroxzero_completion then
  return
end
vim.g.loaded_zeroxzero_completion = true

vim.api.nvim_create_user_command("ZeroCompletionToggle", function()
  require("zeroxzero-completion").toggle()
end, { desc = "0x0: Toggle inline completion" })
