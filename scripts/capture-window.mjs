// 抓取 TiBrowser 原生窗口截图（PrintWindow，不依赖窗口是否在前台）
// 用法：node scripts/capture-window.mjs <输出路径>
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'docs/screenshots/rc1-native-ui.png'
const dir = mkdtempSync(join(tmpdir(), 'tib-cap-'))
const ps1 = join(dir, 'cap.ps1')

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class TibCap {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Best(uint pid, out string title, out int w, out int h2) {
    IntPtr best = IntPtr.Zero; int area = 0; string bestTitle = ""; int bw = 0, bh = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int ww = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (ww > 400 && hh > 300 && ww * hh > area) {
        area = ww * hh; best = h; bw = ww; bh = hh;
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); bestTitle = sb.ToString();
      }
      return true;
    }, IntPtr.Zero);
    title = bestTitle; w = bw; h2 = bh; return best;
  }
  public static bool Shoot(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return false;
    using (var bmp = new Bitmap(w, hh))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc);
      bmp.Save(path, ImageFormat.Png);
    }
    return true;
  }
}
"@
$target = '${out.replace(/\\/g, '\\\\')}'
$procs = Get-Process TiBrowser -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NO_PROCESS'; exit 2 }
foreach ($p in $procs) {
  $t = ''; $w = 0; $h = 0
  $hwnd = [TibCap]::Best([uint32]$p.Id, [ref]$t, [ref]$w, [ref]$h)
  if ($hwnd -ne [IntPtr]::Zero) {
    $ok = [TibCap]::Shoot($hwnd, $target)
    Write-Output ("CAPTURED pid={0} hwnd={1} size={2}x{3} title='{4}' ok={5}" -f $p.Id, $hwnd, $w, $h, $t, $ok)
    exit 0
  } else {
    Write-Output ("SKIP pid={0} (无可见顶层窗口)" -f $p.Id)
  }
}
exit 1
`

writeFileSync(ps1, script, 'utf8')
const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  stdio: 'inherit'
})
process.exit(res.status ?? 1)
