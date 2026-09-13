// 按窗口位置抓屏（GPU 合成的 Chromium 窗口用 PrintWindow 抓到的是白屏，
// 只能从屏幕 DC 取像素；因此本脚本先恢复窗口到前台，再按窗口矩形抓屏）。
// 用法：node scripts/capture-screen.mjs <输出路径>
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'docs/screenshots/rc1-native-ui.png'
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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(uint pid, out int w, out int hh) {
    IntPtr best = IntPtr.Zero; int area = 0; int bw = 0, bh = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.ToString() != "TiBrowser") return true;
      if (IsIconic(h)) { ShowWindow(h, 9); }
      ShowWindow(h, 5);
      SetForegroundWindow(h);
      RECT r; GetWindowRect(h, out r);
      int ww = r.Right - r.Left, hhh = r.Bottom - r.Top;
      if (ww * hhh > area) { area = ww * hhh; best = h; bw = ww; bh = hhh; }
      return true;
    }, IntPtr.Zero);
    w = bw; hh = bh; return best;
  }
  public static bool Rect(IntPtr h, out int x, out int y, out int w, out int hh) {
    RECT r; bool ok = GetWindowRect(h, out r);
    x = r.Left; y = r.Top; w = r.Right - r.Left; hh = r.Bottom - r.Top; return ok;
  }
}
"@
$target = '${out.replace(/\\/g, '\\\\')}'
$proc = Get-Process TiBrowser -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_PROCESS'; exit 2 }
$w = 0; $h = 0
$hwnd = [TibWin]::Find([uint32]$proc.Id, [ref]$w, [ref]$h)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 3 }
Start-Sleep -Milliseconds 1200
$x = 0; $y = 0; $rw = 0; $rh = 0
[TibWin]::Rect($hwnd, [ref]$x, [ref]$y, [ref]$rw, [ref]$rh) | Out-Null
if ($rw -le 0 -or $rh -le 0) { Write-Output 'BAD_RECT'; exit 4 }
$bmp = New-Object System.Drawing.Bitmap($rw, $rh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
$g.Dispose()
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("CAPTURED hwnd={0} rect={1},{2} {3}x{4}" -f $hwnd, $x, $y, $rw, $rh)
`

writeFileSync(ps1, script, 'utf8')
const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  stdio: 'inherit'
})
process.exit(res.status ?? 1)
