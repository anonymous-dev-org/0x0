if exists('g:loaded_zeroxzero_completion')
  finish
endif
let g:loaded_zeroxzero_completion = 1

highlight default ZeroCompletion guifg=#808080 ctermfg=244

command! ZeroCompletionToggle lua require('zeroxzero-completion.completion').toggle()
command! ZeroCompletionClear lua require('zeroxzero-completion.ghost').clear()
