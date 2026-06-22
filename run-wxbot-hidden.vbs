Set WshShell = CreateObject("WScript.Shell")
' 运行 powershell 执行目标脚本，0 表示隐藏窗口 (Hide)
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File ""F:\cx\cx\codex\start-daily-wxbot.ps1""", 0, False
