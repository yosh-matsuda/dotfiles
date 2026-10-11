local wezterm = require 'wezterm'

local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

-- -----------------------------------------------------------------------------
-- Appearance: color scheme
-- -----------------------------------------------------------------------------

config.color_schemes = {
  ['base16-eighties-mod'] = {
    background = '#2D2D2D',
    foreground = '#D3D0C8',

    ansi = {
      '#2D2D2D',
      '#F2777A',
      '#99CC99',
      '#FFCC66',
      '#6699CC',
      '#CC99CC',
      '#66CCCC',
      '#D3D0C8',
    },

    brights = {
      '#747369',
      '#EC3235',
      '#66B166',
      '#FFB118',
      '#3972AD',
      '#B166B1',
      '#39ADAD',
      '#F2F0EC',
    },

    cursor_bg = '#FD9D4F',
    cursor_fg = '#2D2D2D',
    cursor_border = '#FD9D4F',
    selection_fg = '#2D2D2D',
    selection_bg = '#D3D0C8',
  }
}
config.color_scheme = 'base16-eighties-mod'
config.bold_brightens_ansi_colors = 'No'

-- -----------------------------------------------------------------------------
-- Appearance: cursor
-- -----------------------------------------------------------------------------

config.default_cursor_style = 'BlinkingBlock'
config.cursor_blink_rate = 1000
config.cursor_blink_ease_in = 'Constant'
config.cursor_blink_ease_out = 'Constant'

config.visual_bell = {
  fade_in_duration_ms = 75,
  fade_out_duration_ms = 75,
  target = 'CursorColor',
}

-- -----------------------------------------------------------------------------
-- Appearance: window and font
-- -----------------------------------------------------------------------------

-- mintty の Transparency=medium は alpha 255-32
config.window_background_opacity = 223 / 255
config.window_decorations = "RESIZE"
-- 既定の 60 だと 119Hz ディスプレイで最大 1 フレーム余計に遅れる
config.max_fps = 120
config.use_ime = true
config.ime_preedit_rendering = 'Builtin'
local font_family = 'UDEV Gothic NFLG'
local font_features = { 'calt=1', 'clig=1', 'liga=1' }

-- イタリック体は日本語グリフが傾斜分だけ広がり、WezTerm の
-- 「ビットマップ幅 > cell_width * (cells + 0.25) なら 0.5 倍に縮小」判定に
-- 引っかかって一部の全角文字だけ半分の大きさになる。scale <= 0.97 で回避できる。
local italic_scale = 0.96

config.font = wezterm.font_with_fallback {
  {
    family = font_family,
    weight = 'Bold',
    harfbuzz_features = font_features
  },
  -- { family = 'Twemoji Mozilla' },
}
config.font_rules = {
  {
    intensity = 'Normal',
    italic = true,
    font = wezterm.font {
      family = font_family,
      weight = 'Bold',
      style = 'Italic',
      scale = italic_scale,
      harfbuzz_features = font_features,
    },
  },
  {
    intensity = 'Bold',
    italic = true,
    font = wezterm.font {
      family = font_family,
      weight = 'Bold',
      style = 'Italic',
      scale = italic_scale,
      harfbuzz_features = font_features,
    },
  },
  {
    intensity = 'Half',
    italic = true,
    font = wezterm.font {
      family = font_family,
      style = 'Italic',
      scale = italic_scale,
      harfbuzz_features = font_features,
    },
  },
}
config.unicode_version = 9
config.treat_east_asian_ambiguous_width_as_wide = false
config.font_size = 11

-- -----------------------------------------------------------------------------
-- Shell and initial size
-- -----------------------------------------------------------------------------

-- machine.lua は dotfiles の windows role が書き出す
config.default_domain = 'WSL:' .. require('machine').wsl_distro_name
config.launch_menu = {
  {
    label = 'Windows PowerShell',
    args = { 'powershell.exe', '-NoLogo' },
    domain = { DomainName = 'local' },
    cwd = wezterm.home_dir,
  },
}
config.initial_cols = 160
config.initial_rows = 80

-- -----------------------------------------------------------------------------
-- Window snap helper
-- -----------------------------------------------------------------------------

local function get_windows_work_area()
  if not wezterm.target_triple:find('windows') then
    return nil
  end

  local success, stdout = wezterm.run_child_process {
    'powershell.exe',
    '-NoProfile',
    '-Command',
    [[
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WezTermWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hwnd);

  [DllImport("user32.dll")]
  public static extern bool AdjustWindowRectExForDpi(ref RECT lpRect, uint dwStyle, bool bMenu, uint dwExStyle, uint dpi);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int left;
    public int top;
    public int right;
    public int bottom;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }
}
"@
try { [void][WezTermWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
$hwnd = [WezTermWin32]::GetForegroundWindow()
$monitor = [WezTermWin32]::MonitorFromWindow($hwnd, 2)
$info = New-Object WezTermWin32+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
[void][WezTermWin32]::GetMonitorInfo($monitor, [ref]$info)
$frame = New-Object WezTermWin32+RECT
$frame.right = 1000
$frame.bottom = 1000
[void][WezTermWin32]::AdjustWindowRectExForDpi([ref]$frame, 0x00CF0000, $false, 0, [WezTermWin32]::GetDpiForWindow($hwnd))
$work = $info.rcWork
[pscustomobject]@{
  x = $work.left
  y = $work.top
  width = $work.right - $work.left
  height = $work.bottom - $work.top
  frame_height = ($frame.bottom - $frame.top) - 1000
} | ConvertTo-Json -Compress
]],
  }

  if not success then
    return nil
  end

  local ok, area = pcall(wezterm.json_parse, stdout)
  if not ok then
    return nil
  end
  return area
end

local function snap_window_to_work_area(gui_window)
  local dimensions = gui_window:get_dimensions()
  local work_area = get_windows_work_area()

  if work_area then
    -- wezterm は set_inner_size に WS_OVERLAPPEDWINDOW 相当の枠を足して SetWindowPos する
    gui_window:set_position(work_area.x, work_area.y)
    gui_window:set_inner_size(dimensions.pixel_width, work_area.height - work_area.frame_height)
    return
  end

  local screen = wezterm.gui.screens().active
  gui_window:set_position(screen.x or 0, screen.y or 0)
  gui_window:set_inner_size(dimensions.pixel_width, screen.height)
end

-- -----------------------------------------------------------------------------
-- Clipboard helper
-- -----------------------------------------------------------------------------

-- 矩形選択は各行を選択幅までスペースで埋めて返すため、行末を落としてからコピーする
local function copy_selection(window, pane)
  local selection = window:get_selection_text_for_pane(pane)
  if not selection or selection == '' then
    return false
  end

  local trimmed = selection:gsub('[ \t]+(\r?\n)', '%1'):gsub('[ \t]+$', '')
  window:copy_to_clipboard(trimmed, 'Clipboard')
  return true
end

-- -----------------------------------------------------------------------------
-- Mouse behavior
-- -----------------------------------------------------------------------------

-- Windows のデフォルトは false で、フォーカス用のクリックがペインにも渡ってしまう
config.swallow_mouse_click_on_window_focus = true

-- herdr と同じく選択完了時にコピーする。既定の CompleteSelection は矩形選択の padding まで含めるので使わない
local copy_on_release = wezterm.action_callback(function(window, pane)
  copy_selection(window, pane)
end)

config.mouse_bindings = {
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'NONE',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'SHIFT',
    action = copy_on_release,
  },
  -- ALT / ALT+SHIFT は矩形選択
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'ALT',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'ALT|SHIFT',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 2, button = 'Left' } },
    mods = 'NONE',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 2, button = 'Left' } },
    mods = 'SHIFT',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 3, button = 'Left' } },
    mods = 'NONE',
    action = copy_on_release,
  },
  {
    event = { Up = { streak = 3, button = 'Left' } },
    mods = 'SHIFT',
    action = copy_on_release,
  },
  -- 左クリックからリンクを開く動作を潰したので CTRL+クリックに移す
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'CTRL',
    action = wezterm.action.OpenLinkAtMouseCursor,
  },
  -- Up だけ割り当てると Down がアプリに漏れるので合わせて無効化する
  {
    event = { Down = { streak = 1, button = 'Left' } },
    mods = 'CTRL',
    action = wezterm.action.Nop,
  },
  {
    event = { Down = { streak = 1, button = 'Right' } },
    mods = 'NONE',
    action = wezterm.action_callback(function(window, pane)
      if copy_selection(window, pane) then
        window:perform_action(wezterm.action.ClearSelection, pane)
      else
        window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
      end
    end),
  },
}

-- -----------------------------------------------------------------------------
-- Key bindings
-- -----------------------------------------------------------------------------

-- 有効にすると IME の1文字確定が合成テキスト扱いされず落ちるため無効のままにする
config.enable_kitty_keyboard = false

config.keys = {
  {
    key = 't',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SpawnTab { DomainName = config.default_domain },
  },
  {
    key = 'l',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ShowLauncher,
  },
  -- kitty keyboard を切っているので、レガシー encode では Shift+Enter が CR、
  -- CTRL+Enter が LF に潰れてしまう。CSI u を直接送る
  {
    key = 'Enter',
    mods = 'SHIFT',
    action = wezterm.action.SendString '\x1b[13;2u',
  },
  {
    key = 'Enter',
    mods = 'CTRL',
    action = wezterm.action.SendString '\x1b[13;5u',
  },
  {
    key = 'v',
    mods = 'CTRL',
    action = wezterm.action.PasteFrom 'Clipboard',
  },
  -- 既定のフルスクリーン切り替えを外し、VS Code と同じく Alt+Enter をアプリに渡す
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.DisableDefaultAssignment,
  },
  -- 既定の CopyTo は選択が空でもクリップボードを上書きし、herdr でコピーした内容を消してしまう
  {
    key = 'c',
    mods = 'CTRL|SHIFT',
    action = wezterm.action_callback(function(window, pane)
      copy_selection(window, pane)
    end),
  },
  {
    key = 's',
    mods = 'CTRL|SHIFT',
    action = wezterm.action_callback(function(window, _pane)
      snap_window_to_work_area(window)
    end),
  },
}

-- -----------------------------------------------------------------------------
-- Startup behavior
-- -----------------------------------------------------------------------------

wezterm.on('gui-startup', function(cmd)
  local _tab, _pane, window = wezterm.mux.spawn_window(cmd or {})
  local gui_window = window:gui_window()
  snap_window_to_work_area(gui_window)
end)

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------

-- OSC 9 / OSC 777 のトースト。herdr が全ペイン分を 1 つの WezTerm ペインから出すため、フォーカス中でも抑制しない
config.notification_handling = 'AlwaysShow'

-- -----------------------------------------------------------------------------
-- Tab bar
-- -----------------------------------------------------------------------------

wezterm.on('new-tab-button-click', function(window, pane, button)
  if button == 'Left' then
    window:perform_action(wezterm.action.SpawnTab { DomainName = config.default_domain }, pane)
    return false
  elseif button == 'Right' then
    window:perform_action(wezterm.action.ShowLauncher, pane)
    return false
  end
end)

local SOLID_LEFT_ARROW = wezterm.nerdfonts.ple_lower_right_triangle
local SOLID_RIGHT_ARROW = wezterm.nerdfonts.ple_upper_left_triangle

wezterm.on('format-tab-title', function(tab, _tabs, _panes, _config, _hover, max_width)
  local background = '#5c6d74'
  local foreground = '#FFFFFF'
  local edge_background = 'none'

  if tab.is_active then
    background = '#ae8b2d'
    foreground = '#FFFFFF'
  end

  local edge_foreground = background
  -- 両端の三角 2 桁と左右の空白 6 桁を差し引かないと右端の三角が切れる
  local title = '   ' .. wezterm.truncate_right(tab.active_pane.title, math.max(max_width - 8, 1)) .. '   '

  return {
    { Background = { Color = edge_background } },
    { Foreground = { Color = edge_foreground } },
    { Text = SOLID_LEFT_ARROW },
    { Background = { Color = background } },
    { Foreground = { Color = foreground } },
    { Text = title },
    { Background = { Color = edge_background } },
    { Foreground = { Color = edge_foreground } },
    { Text = SOLID_RIGHT_ARROW },
  }
end)

return config
