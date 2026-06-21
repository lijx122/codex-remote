# Codex Remote App-Server launcher for PoC
$token = "poc-verify-token-2026"
$sha = [BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [Text.Encoding]::UTF8.GetBytes($token)
  )
).Replace("-","").ToLower()

$bin = "C:\Users\l\AppData\Local\OpenAI\Codex\bin\8e55c2dd143b6354\codex.exe"
$port = 18770

Write-Host "Starting Codex App Server on ws://127.0.0.1:$port"
Write-Host "Token SHA-256: $sha"

& $bin app-server `
  --listen "ws://127.0.0.1:$port" `
  --ws-auth capability-token `
  --ws-token-sha256 $sha
