// Windows tray icon.
//
// Bun has no native tray API, so the icon is run by a hidden PowerShell helper
// (Windows Forms NotifyIcon) that the daemon spawns and owns. The script is
// passed as -EncodedCommand, so nothing is written to disk and the binary stays
// a single file.
//
// The helper talks back over the same HTTP port: "Stop daemon" calls /shutdown,
// and a poll of /status makes the icon disappear if the daemon dies on its own.

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = '__BASE__'
$token = '__TOKEN__'

# Draw the icon at runtime so no image file has to ship with the binary:
# a blue disc with a white play triangle.
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$disc = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 76, 141, 255))
$graphics.FillEllipse($disc, 0, 0, 31, 31)
$triangle = @(
  (New-Object System.Drawing.Point 12, 8),
  (New-Object System.Drawing.Point 25, 16),
  (New-Object System.Drawing.Point 12, 24)
)
$graphics.FillPolygon([System.Drawing.Brushes]::White, $triangle)
$graphics.Dispose()
$disc.Dispose()

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$script:notify.Text = 'obs-video-trigger - ' + $base
$script:notify.Visible = $true

function Close-Tray {
  $script:notify.Visible = $false
  $script:notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add('Open overlay page')
$openItem.Add_Click({ Start-Process ($base + '/overlay') })

$copyItem = $menu.Items.Add('Copy overlay URL')
$copyItem.Add_Click({ Set-Clipboard -Value ($base + '/overlay') })

$hideItem = $menu.Items.Add('Hide the playing clip')
$hideItem.Add_Click({
  try { Invoke-WebRequest -Uri ($base + '/stop') -TimeoutSec 3 -UseBasicParsing | Out-Null } catch {}
})

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quitItem = $menu.Items.Add('Stop daemon')
$quitItem.Add_Click({
  try {
    Invoke-WebRequest -Uri ($base + '/shutdown?token=' + $token) -Method POST -TimeoutSec 3 -UseBasicParsing | Out-Null
  } catch {}
  Close-Tray
})

$script:notify.ContextMenuStrip = $menu
$script:notify.Add_DoubleClick({ Start-Process ($base + '/overlay') })

# If the daemon is stopped from its console instead, take the icon away too.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({
  try {
    Invoke-WebRequest -Uri ($base + '/status') -TimeoutSec 2 -UseBasicParsing | Out-Null
  } catch {
    $timer.Stop()
    Close-Tray
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
`;

export type Tray = { stop: () => void };

export function startTray(base: string, token: string): Tray | null {
  if (process.platform !== "win32") return null;

  const script = SCRIPT.replaceAll("__BASE__", base).replaceAll("__TOKEN__", token);
  // -EncodedCommand takes base64 of UTF-16LE, which avoids any quoting problems.
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  try {
    const child = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      // windowsHide starts the helper with CREATE_NO_WINDOW. Without it, a
      // console-less daemon makes PowerShell allocate a visible console of
      // its own before -WindowStyle Hidden can take effect.
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
    );
    return { stop: () => child.kill() };
  } catch (err) {
    console.error(`warning: could not start the tray icon (${(err as Error).message})`);
    return null;
  }
}
