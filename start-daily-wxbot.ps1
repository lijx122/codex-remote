$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = "node"

$LogDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Force $LogDir | Out-Null

Write-Host "=== Codex Remote ==="
Write-Host "Web UI : http://127.0.0.1:8787"
Write-Host "WeChat : scan QR if needed"
Write-Host ""

# Start codex-control-plane (Web UI + REST API)
$ControlPlaneLog = Join-Path $LogDir "control-plane.log"
Write-Host "[control-plane] starting..."
$controlPlaneJob = Start-Job -Name "codex-control-plane" -ScriptBlock {
  param($node, $root, $log)
  Set-Location $root
  & $node tools\codex-control-plane.js *>> $log
} -ArgumentList $Node, $Root, $ControlPlaneLog

# Start WeChat iLink adapter
$WxBotLog = Join-Path $LogDir "wxbot.log"
Write-Host "[wxbot] starting..."
$wxbotJob = Start-Job -Name "codex-wxbot" -ScriptBlock {
  param($node, $root, $log)
  Set-Location $root
  & $node adapters\wxbot\bin\ilink.js *>> $log
} -ArgumentList $Node, $Root, $WxBotLog

Write-Host ""
Write-Host "Both services started. Logs:"
Write-Host "  control-plane: $ControlPlaneLog"
Write-Host "  wxbot        : $WxBotLog"
Write-Host ""
Write-Host "Press Ctrl+C to stop both."

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
