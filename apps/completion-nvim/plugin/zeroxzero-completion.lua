--- 0x0-completion plugin loader.

if vim.g.loaded_zeroxzero_completion then
  return
end
vim.g.loaded_zeroxzero_completion = true

vim.api.nvim_create_user_command("ZeroCompletionSettings", function()
  require("zeroxzero-completion").settings()
end, { desc = "0x0: Configure inline completion" })
