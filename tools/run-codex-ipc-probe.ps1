param(
  [ValidateSet("init", "listen", "request", "history", "follow")]
  [string]$Command = "init",

  [string]$Method = "",

  [string]$ParamsJson = "{}",

  [string]$ConversationId = "",

  [string]$Text = "hello from ipc probe",

  [int]$ListenMs = 3000
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$client = Join-Path $repoRoot "tools\codex-ipc-client.js"
$log = Join-Path $repoRoot "reports\codex-ipc-runtime.log"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $node = $nodeCmd.Source
} else {
  $bundledNode = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundledNode) {
    $node = $bundledNode
  } else {
    $fnmCmd = Get-Command fnm -ErrorAction SilentlyContinue
    if (-not $fnmCmd) {
      throw "Node not found, bundled Node missing, and fnm not found."
    }
    fnm env --use-on-cd | Out-String | Invoke-Expression
    $node = (Get-Command node -ErrorAction Stop).Source
  }
}

$env:CODEX_IPC_LOG = $log
$env:CODEX_IPC_LISTEN_MS = [string]$ListenMs

Write-Host "USER      $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-Host "NODE      $node"
Write-Host "CLIENT    $client"
Write-Host "LOG       $log"

if ($Command -eq "request") {
  if (-not $Method) {
    throw "Method is required when Command=request."
  }
  & $node $client request $Method $ParamsJson
} elseif ($Command -eq "history") {
  if (-not $ConversationId) {
    throw "ConversationId is required when Command=history."
  }
  & $node $client history $ConversationId
} elseif ($Command -eq "follow") {
  if (-not $ConversationId) {
    throw "ConversationId is required when Command=follow."
  }
  & $node $client follow $ConversationId $Text
} else {
  & $node $client $Command
}

exit $LASTEXITCODE
