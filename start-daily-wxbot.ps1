$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "node"
$LogDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Force $LogDir | Out-Null

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

Write-Host "=== Codex Remote ==="
Write-Host "Web UI : http://${hostAddr}:$port"
Write-Host "WeChat : scan QR if needed"
Write-Host ""

# Start codex-control-plane
$ControlPlaneLog = Join-Path $LogDir "control-plane.log"
Write-Host "[control-plane] starting..."
$controlPlaneJob = Start-Job -Name "codex-control-plane" -ScriptBlock {
  param($node, $root, $log)
  Set-Location $root
  & $node tools\codex-control-plane.js *>> $log
} -ArgumentList $Node, $Root, $ControlPlaneLog

# Start WeChat iLink
$WxBotLog = Join-Path $LogDir "wxbot.log"
Write-Host "[wxbot] starting..."
$wxbotJob = Start-Job -Name "codex-wxbot" -ScriptBlock {
  param($node, $root, $log)
  Set-Location $root
  & $node adapters\wxbot\bin\ilink.js *>> $log
} -ArgumentList $Node, $Root, $WxBotLog

Write-Host ""
Write-Host "Logs:"
Write-Host "  control-plane: $ControlPlaneLog"
Write-Host "  wxbot        : $WxBotLog"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
  while ($true) {
    Start-Sleep -Seconds 5
    if ($controlPlaneJob.State -ne 'Running') {
      Write-Host "[control-plane] stopped unexpectedly"
      Receive-Job $controlPlaneJob
      break
    }
    if ($wxbotJob.State -ne 'Running') {
      Write-Host "[wxbot] stopped unexpectedly"
      Receive-Job $wxbotJob
      break
    }
  }
} finally {
  Stop-Job -Name "codex-control-plane", "codex-wxbot" -ErrorAction SilentlyContinue
  Remove-Job -Name "codex-control-plane", "codex-wxbot" -ErrorAction SilentlyContinue
}
