# Web Adapter

Reference adapter for `codex-control-plane`.

This adapter is static HTML/CSS/JS. It does not access Codex IPC, Desktop
runtime, pipe, client IDs, or discovery. It only calls Control Plane REST and
WebSocket APIs.

## Files

```text
index.html
app.js
style.css
```

## Run

Start Control Plane from a normal Windows user PowerShell:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$env:CODEX_CONTROL_PLANE_HOST = "0.0.0.0"
$env:CODEX_CONTROL_PLANE_PORT = "8787"
& $node F:\cx\cx\codex\tools\codex-control-plane.js
```

Control Plane serves this adapter at:

```text
http://<desktop-lan-ip>:8787/
```

Open that URL from a phone browser. Set the Control Plane URL in the header:

```text
http://<desktop-lan-ip>:8787
```

## Required Control Plane APIs

```text
GET  /threads
GET  /history/:conversationId
POST /send
POST /interrupt
POST /approve
WS   /events?conversationId=<conversationId>
```
