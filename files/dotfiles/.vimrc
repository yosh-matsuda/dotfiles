" Ward off unexpected things that your distro might have made, as
" well as sanely reset options when re-sourcing .vimrc
set nocompatible

" Install Dein
let $CACHE = expand('~/.cache')
if !($CACHE->isdirectory())
  call mkdir($CACHE, 'p')
endif
if &runtimepath !~# '/dein.vim'
  let s:dir = 'dein.vim'->fnamemodify(':p')
  if !(s:dir->isdirectory())
    let s:dir = $CACHE .. '/dein/repos/github.com/Shougo/dein.vim'
    if !(s:dir->isdirectory())
      execute '!git clone https://github.com/Shougo/dein.vim' s:dir
    endif
  endif
  execute 'set runtimepath^='
        \ .. s:dir->fnamemodify(':p')->substitute('[/\\]$', '', '')
endif

" Set dein base path (required)
let s:dein_base = '~/.cache/dein/'

" Set dein source path (required)
let s:dein_src = '~/.cache/dein/repos/github.com/Shougo/dein.vim'

" Set dein runtime path (required)
execute 'set runtimepath+=' .. s:dein_src

" Call dein initialization (required)
call dein#begin(s:dein_base)

call dein#add(s:dein_src)

" Your plugins go here:
call dein#add('Shougo/neosnippet.vim')
call dein#add('Shougo/neosnippet-snippets')
call dein#add('nathanaelkane/vim-indent-guides')
call dein#add('brafales/vim-desert256')

" Finish Dein initialization (required)
call dein#end()

" Attempt to determine the type of a file based on its name and possibly its
" contents. Use this to allow intelligent auto-indenting for each filetype,
" and for plugins that are filetype specific.
filetype indent plugin on

" Enable syntax highlighting
if has('syntax')
  syntax on
endif

" Uncomment if you want to install not-installed plugins on startup.
if dein#check_install()
  call dein#install()
endif

" BS キー修正
set backspace=indent,eol,start

" DELキー修正
set t_kD=[3~
" fixdel

" color
set t_Co=256
colorscheme desert256

" 検索結果をハイライト
set hlsearch

" カーソルを行頭、行末で止まらないようにする
set whichwrap=b,s,h,l,<,>,[,]

" vim 内部&デフォルト文字コード と 自動判別順
set encoding=utf-8
set fileencodings=iso-2022-jp,utf-8,euc-jp,cp932,sjis,cs-bom,iso-2022-jp-3,eucjp-ms,euc-jisx0213
set fileformats=unix,dos,mac

" 行番号を表示
set number

" マウスを使用
set mouse=a

" バックアップディレクトリ
set backup
set backupdir=$HOME/tmp
let &directory = &backupdir

" オートインデント
" set autoindent

" スマートインデント
set smartindent

" オートインデント時にインデントする文字数
set shiftwidth=2

" タブの空白数
set tabstop=2

" TAB 文字の代わりにスペースを使う
set expandtab

" ソフトタブ空白数
set softtabstop=2

" 大文字小文字区別なく検索
set ignorecase

" ルーラー表示 (ステータスラインと排他)
"set ruler

" ステータスライン
set statusline=%F%m%r%h%w\%=\ %Y\ %{&ff}\ %{&fileencoding}\ \[%04l,%04v\]
set laststatus=2

" ○とか↑とかの幅
set ambiwidth=double

"改行文字とタブ文字を表示
set list
set listchars=tab:>\

" 全角スペース・行末のスペース・タブの可視化
if has("syntax")
  syntax on
  " PODバグ対策
  syn sync fromstart
  function! ActivateInvisibleIndicator()
    " 下の行の"　"は全角スペース
    syntax match InvisibleJISX0208Space "　" display containedin=ALL
    highlight InvisibleJISX0208Space term=underline ctermbg=Blue guibg=darkgray gui=underline
    syntax match InvisibleTrailedSpaceWithSemicolon "\s\+;$" display containedin=ALL
    highlight InvisibleTrailedSpaceWithSemicolon term=underline ctermbg=Red guibg=NONE gui=undercurl guisp=darkorange
    syntax match InvisibleTrailedSpace "\S\s\+$" display containedin=ALL
    highlight InvisibleTrailedSpace term=underline ctermbg=Red guibg=NONE gui=undercurl guisp=darkorange
    "syntax match InvisibleTab "\t" display containedin=ALL
    "highlight InvisibleTab term=underline ctermbg=white gui=undercurl guisp=darkslategray
  endf
  augroup invisible
    autocmd! invisible
    autocmd BufNew,BufRead * call ActivateInvisibleIndicator()
  augroup END
endif

" カーソルの変更
let &t_SI .= "\e[5 q"
let &t_EI .= "\e[1 q"

" Indent Guildes
let g:indent_guides_enable_on_vim_startup = 1
let g:indent_guides_auto_colors = 1
autocmd VimEnter,Colorscheme * :hi IndentGuidesOdd  ctermbg=darkgrey
autocmd VimEnter,Colorscheme * :hi IndentGuidesEven ctermbg=lightgrey
let g:indent_guides_guide_size = 1
let g:indent_guides_space_guides = 1
let g:indent_guides_start_level = 2

" キーバインド設定

" 対応括弧セット
inoremap {} {}<LEFT>
inorema:p [] []<LEFT>
inoremap () ()<LEFT>
inoremap "" ""<LEFT>
inoremap '' ''<LEFT>
inoremap <> <><LEFT>

" tab 移動
nmap <Tab>      gt
nmap <S-Tab>    gT

" 保存時にsudo権限で保存
cnoremap w!! w !sudo tee > /dev/null %<CR> :e!<CR>

" いくつかのやや重い設定

" 閉じ括弧が入力されたとき、対応する括弧を表示する
set showmatch

" カレントウィンドウにのみ罫線を引く
"augroup cch
"  autocmd! cch
"  autocmd WinLeave * set nocursorline
"  autocmd WinEnter,BufRead * set cursorline
"augroup END
"hi clear CursorLine
"hi CursorLine term=underline cterm=underline gui=underline
"highlight CursorLine ctermbg=black guibg=black

"カーソルラインを必要なときだけ可視化
augroup vimrc-auto-cursorline
  autocmd!
  autocmd CursorMoved,CursorMovedI * call s:auto_cursorline('CursorMoved')
  autocmd CursorHold,CursorHoldI * call s:auto_cursorline('CursorHold')
  autocmd WinEnter * call s:auto_cursorline('WinEnter')
  autocmd WinLeave * call s:auto_cursorline('WinLeave')

  let s:cursorline_lock = 0
  function! s:auto_cursorline(event)
    if a:event ==# 'WinEnter'
      setlocal cursorline
      let s:cursorline_lock = 2
    elseif a:event ==# 'WinLeave'
      setlocal nocursorline
    elseif a:event ==# 'CursorMoved'
      if s:cursorline_lock
        if 1 < s:cursorline_lock
          let s:cursorline_lock = 1
        else
          setlocal nocursorline
          let s:cursorline_lock = 0
        endif
      endif
    elseif a:event ==# 'CursorHold'
      setlocal cursorline
      let s:cursorline_lock = 1
    endif
  endfunction
augroup END
