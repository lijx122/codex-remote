$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Force $LogDir | Out-Null

$null = Start-Job -Name "codex-control-plane" -ScriptBlock {
  param($r, $l)
  Set-Location $r
  node tools/codex-control-plane.js *>> $l
} -ArgumentList $Root, (Join-Path $LogDir "control-plane.log")

$null = Start-Job -Name "codex-wxbot" -ScriptBlock {
  param($r, $l)
  Set-Location $r
  node adapters/wxbot/bin/ilink.js *>> $l
} -ArgumentList $Root, (Join-Path $LogDir "wxbot.log")

Write-Host "Jobs started:"
Get-Job -Name "codex-*" | Select-Object Id, Name, State | Format-Table -AutoSize
Write-Host ""
Write-Host "Control-plane log: $LogDir\control-plane.log"
Write-Host "Wxbot log:         $LogDir\wxbot.log"
