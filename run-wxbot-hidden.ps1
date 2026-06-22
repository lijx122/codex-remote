$targetScript = "F:\cx\cx\codex\start-daily-wxbot.ps1"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "powershell.exe"
$psi.Arguments = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$targetScript`""
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
[System.Diagnostics.Process]::Start($psi) | Out-Null
