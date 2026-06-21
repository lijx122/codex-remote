# codex-control-plane

Control Plane exposes `codex-follower-core` as stable REST commands and a
WebSocket event stream.

Adapters must call this package or `codex-follower-core`. They must not access
Codex Desktop IPC directly.

## Start

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node F:\cx\cx\codex\tools\codex-control-plane.js
```

Defaults:

```text
host: 127.0.0.1
port: 8787
```

Override:

```powershell
$env:CODEX_CONTROL_PLANE_HOST = "127.0.0.1"
$env:CODEX_CONTROL_PLANE_PORT = "8787"
```

## REST Command API

## Built-in Web Adapter

Control Plane also serves the reference Web Adapter:

```text
http://127.0.0.1:8787/
```

Static files are loaded from:

```text
adapters/web/
```

### Threads

```http
GET /threads
```

Response:

```json
[
  {
    "conversationId": "...",
    "title": "...",
    "updatedAt": null
  }
]
```

### Send

```http
POST /send
content-type: application/json

{
  "conversationId": "...",
  "message": "继续执行"
}
```

### Interrupt

```http
POST /interrupt
content-type: application/json

{
  "conversationId": "..."
}
```

### Approve

```http
POST /approve
content-type: application/json

{
  "conversationId": "...",
  "approvalId": "...",
  "decision": true
}
```

`decision: true` maps to `allow`; false maps to `deny`.

### History

```http
GET /history/:conversationId
```

## WebSocket Event API

```text
ws://127.0.0.1:8787/events?conversationId=<conversationId>
```

Wire format:

```json
{
  "type": "message",
  "conversationId": "...",
  "payload": {}
}
```

Event types:

```text
message
turn_started
turn_completed
approval_request
approval_response
interrupt
thread_state_changed
error
```

## Core Boundary

Control Plane only calls:

```ts
connect()
loadHistory()
sendMessage()
interrupt()
approve()
subscribeEvents()
```

It does not access pipe paths, frames, request IDs, discovery, target client IDs,
or source client IDs.
