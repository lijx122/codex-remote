$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Force $LogDir | Out-Null

# Resolve node via fnm if available
$nodePath = "node"
try {
  $fnmOut = fnm env 2>$null
  if ($fnmOut) {
    $fnmOut | ForEach-Object { Invoke-Expression $_ }
    $resolved = (Get-Command node -ErrorAction Stop).Source
    if ($resolved) { $nodePath = $resolved }
  }
} catch {}

# Read .env for display
$envPath = Join-Path $Root ".env"
$hostAddr = "127.0.0.1"
$port = "8787"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*CODEX_CONTROL_PLANE_HOST\s*=\s*(.+)$') { $hostAddr = $matches[1].Trim() }
    if ($_ -match '^\s*CODEX_CONTROL_PLANE_PORT\s*=\s*(.+)$') { $port = $matches[1].Trim() }
  }
}

# Kill any leftover node processes from previous runs on our scripts
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
  try { $_.CommandLine -match "codex-control-plane|ilink\.js" } catch { $false }
} | Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue

$ControlPlaneLog = Join-Path $LogDir "control-plane.log"
$WxBotLog = Join-Path $LogDir "wxbot.log"

# Start as background processes with proper UTF-8 output
$cpProc = Start-Process -FilePath $nodePath `
  -ArgumentList "tools\codex-control-plane.js" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $ControlPlaneLog `
  -RedirectStandardError (Join-Path $LogDir "control-plane.err") `
  -PassThru

$wxProc = Start-Process -FilePath $nodePath `
  -ArgumentList "adapters\wxbot\bin\ilink.js" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $WxBotLog `
  -RedirectStandardError (Join-Path $LogDir "wxbot.err") `
  -PassThru

# Write PID file for cleanup
$pidFile = Join-Path $LogDir "pids.json"
@{ controlPlane = $cpProc.Id; wxbot = $wxProc.Id; startedAt = (Get-Date -Format o) } |
  ConvertTo-Json | Out-File $pidFile -Encoding utf8
