// 抓取 TiBrowser 原生窗口截图。
//
// 为什么需要这么麻烦：
//  1. Chromium 的窗口是 GPU 合成的，PrintWindow 抓到的常常是白屏 —— 必须从屏幕 DC 取像素；
//  2. 从屏幕 DC 取像素要求窗口真的在前台且未被遮挡 —— 需要先恢复 + 置顶，并轮询确认；
//  3. CEF 首次创建 Alloy 窗口时会落在最小化状态，直接抓会抓到桌面或任务栏。
//
// 用法：node scripts/capture-screen.mjs <输出路径> [等待毫秒]
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'docs/screenshots/rc1-native-ui.png'
const settle = Number(process.argv[3] ?? 1500)
const dir = mkdtempSync(join(tmpdir(), 'tib-cap-'))
const ps1 = join(dir, 'cap.ps1')

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class TibWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }

  // 找到指定进程里面积最大的可见顶层窗口（即主窗口）
  public static IntPtr MainWindow(uint pid, out int w, out int hh, out string title) {
    IntPtr best = IntPtr.Zero; int area = 0; int bw = 0, bh = 0; string bt = "";
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      RECT r; GetWindowRect(h, out r);
      int ww = r.Right - r.Left, hhh = r.Bottom - r.Top;
      if (ww <= 0 || hhh <= 0) return true;
      if (ww * hhh > area) {
        area = ww * hhh; best = h; bw = ww; bh = hhh;
        var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); bt = sb.ToString();
      }
      return true;
    }, IntPtr.Zero);
    w = bw; hh = bh; title = bt; return best;
  }

  // 切到前台：先取消最小化，再置顶/激活
  public static void Foreground(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
    ShowWindow(h, 5);                    // SW_SHOW
    // HWND_TOPMOST(-1) + SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW：置顶不需要前台权限
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0003 | 0x0040);
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }
}
"@

$target = '${out.replace(/\\/g, '\\\\')}'
$proc = Get-Process TiBrowser -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_PROCESS'; exit 2 }

$w = 0; $h = 0; $title = ''
$hwnd = [TibWin]::MainWindow([uint32]$proc.Id, [ref]$w, [ref]$h, [ref]$title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 3 }
Write-Output ("窗口: hwnd={0} {1}x{2} title='{3}'" -f $hwnd, $w, $h, $title)

[TibWin]::Foreground($hwnd)
Start-Sleep -Milliseconds ${settle}

# 再确认一次：仍未在前台就重试若干次（任务栏抢焦点很常见）
for ($i = 0; $i -lt 6; $i++) {
  if ([TibWin]::GetForegroundWindow() -eq $hwnd) { break }
  [TibWin]::Foreground($hwnd)
  Start-Sleep -Milliseconds 400
}
$fg = [TibWin]::GetForegroundWindow()
Write-Output ("前台窗口匹配 = {0}" -f ($fg -eq $hwnd))

$x = 0; $y = 0; $rw = 0; $rh = 0
$r = New-Object TibWin+RECT
# 重新取一次矩形：恢复后位置可能变化
[void][TibWin]::GetWindowRect($hwnd, [ref]$r)
$x = $r.Left; $y = $r.Top; $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top
if ($rw -le 0 -or $rh -le 0) { Write-Output 'BAD_RECT'; exit 4 }

Start-Sleep -Milliseconds 600
$bmp = New-Object System.Drawing.Bitmap($rw, $rh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
$g.Dispose()
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("CAPTURED {0}x{1} @ {2},{3} → {4}" -f $rw, $rh, $x, $y, $target)
`

writeFileSync(ps1, script, 'utf8')
const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  stdio: 'inherit'
})
process.exit(res.status ?? 1)
