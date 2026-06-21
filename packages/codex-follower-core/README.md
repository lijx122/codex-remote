# codex-follower-core

Reusable core layer for controlling the current Codex Desktop follower runtime.

This package hides all IPC details from adapters. Callers do not handle pipe paths,
frames, request IDs, client IDs, target clients, or discovery.

## Directory Layout

```text
packages/
  codex-follower-core/
    src/
      event-bus.js
      index.d.ts
      index.js
      ipc-transport.js
  codex-follower-cli/
    bin/
      codex-follower.js
```

## Public API

```ts
connect(): Promise<{ clientId: string }>
disconnect(): void
listThreads(): ThreadSummary[]
loadHistory(conversationId: string): Promise<LoadHistoryResult>
sendMessage(conversationId: string, text: string): Promise<SendMessageResult>
interrupt(conversationId: string): Promise<CommandResult>
approve(conversationId: string, approvalId: string, decision: "allow" | "deny"): Promise<CommandResult>
subscribeEvents(conversationId: string): CodexFollowerEventBus
```

`sendMessage()` starts a new turn through the Desktop follower runtime. It is
not implemented as queued input.

## Event Model

```ts
type CodexFollowerEventType =
  | "message"
  | "turn_started"
  | "turn_completed"
  | "approval_request"
  | "approval_response"
  | "interrupt"
  | "thread_state_changed"
  | "error";
```

Use `subscribeEvents(conversationId)` to receive scoped events. The event bus also
supports `"*"` for all scoped events.

## CLI Demo

Run directly from this repository:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

& $node F:\cx\cx\codex\tools\codex-follower.js list
& $node F:\cx\cx\codex\tools\codex-follower.js history 019ee451-eed0-7c21-b1a6-8e56d603e82b
& $node F:\cx\cx\codex\tools\codex-follower.js send 019ee451-eed0-7c21-b1a6-8e56d603e82b "hello"
& $node F:\cx\cx\codex\tools\codex-follower.js interrupt 019ee451-eed0-7c21-b1a6-8e56d603e82b
```

Run these from a normal Windows user PowerShell session. Codex sandbox sessions may
not have permission to open `\\.\pipe\codex-ipc`.
