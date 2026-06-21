# codex-wxbot-adapter

WeChat Adapter MVP for controlling Codex Desktop through `codex-control-plane`.

Boundary:

- Calls only Control Plane HTTP/WebSocket APIs.
- Does not access Codex IPC, Desktop internals, app-server, sqlite, or rollout files.
- Keeps state in memory only.

## Commands

```text
/list          show recent conversations
/q <id>        switch current conversation by full id or prefix
/where         show current conversation
/history       show last 20 messages
/stop          interrupt current turn
/approve yes   approve pending request
/approve no    deny pending request
/y             approve pending request
/n             deny pending request
/full          show last completed full assistant result
/new           not supported until Control Plane exposes create-thread
/help          show help
```

Normal messages are sent to the current conversation through `POST /send`.

## Event Strategy

The adapter intentionally does not mirror Desktop UI.

Pushed to WeChat:

- `approval_request`
- `turn_completed`
- `error`

Ignored:

- token/message deltas
- tool calls
- tool output
- terminal output
- `thread_state_changed`
- `turn_started`
- `interrupt`

On `turn_completed`, the adapter calls `GET /history/:conversationId`, extracts the latest assistant message, sends a 300-500 character summary, and stores the full result for `/full`.

## Recommended: Direct iLink Runner

This is the real WeChat binding path. It does not require openclaw.

Flow:

```text
codex-wxbot-ilink
  -> iLink get_bot_qrcode
  -> WeChat scan
  -> iLink bot_token
  -> iLink getupdates long polling
  -> WxBotAdapter
  -> Control Plane
  -> iLink sendmessage
```

Start Control Plane first:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node F:\cx\cx\codex\tools\codex-control-plane.js
```

Then start WeChat iLink:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$env:CODEX_CONTROL_PLANE_URL = "http://127.0.0.1:8787"
& $node F:\cx\cx\codex\tools\codex-wxbot-ilink.js
```

The runner writes login artifacts to:

```text
F:\cx\cx\codex\adapters\wxbot\.runtime\
```

Usually use:

```text
ilink-qrcode.png
```

Scan it in WeChat. After confirmation, send `/help` or `/list` from WeChat.

If you already have a valid iLink bot token:

```powershell
$env:ILINK_BOT_TOKEN = "<token>"
& $node F:\cx\cx\codex\tools\codex-wxbot-ilink.js
```

The MVP keeps token and cursor in memory. Restarting without `ILINK_BOT_TOKEN`
requires scanning again.

## Console Test

Start Control Plane first:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node F:\cx\cx\codex\tools\codex-control-plane.js
```

Then run the console adapter:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node F:\cx\cx\codex\adapters\wxbot\bin\console.js
```

Try:

```text
/list
/q 019ee451
hello
```

## HTTP Bridge

This is only a debug/compatibility bridge. It does not log into WeChat by itself.

If another WeChat framework already owns login and message delivery, point its
text callback to:

```text
POST http://127.0.0.1:8790/message
content-type: application/json

{ "text": "hello" }
```

Start:

```powershell
$node = "C:\Users\l\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$env:CODEX_CONTROL_PLANE_URL = "http://127.0.0.1:8787"
$env:WXBOT_HOST = "127.0.0.1"
$env:WXBOT_PORT = "8790"
& $node F:\cx\cx\codex\adapters\wxbot\bin\http-bridge.js
```

If the WeChat framework needs outbound push through a webhook, set:

```powershell
$env:WXBOT_OUTGOING_WEBHOOK = "http://127.0.0.1:<wechat-framework-port>/send"
```

Without `WXBOT_OUTGOING_WEBHOOK`, replies are printed to stdout and stored in:

```text
GET http://127.0.0.1:8790/outbox
```

## Embedding in iLink/openclaw-weixin

Use the adapter as a small business layer:

```js
const { createWxBotAdapter } = require("./adapters/wxbot/src");

const adapter = createWxBotAdapter({
  controlPlaneUrl: "http://127.0.0.1:8787",
  sendText: async (text) => {
    await wechat.sendText(text);
  }
});

wechat.onText(async (message) => {
  await adapter.handleText(message.text);
});
```

The WeChat SDK owns login and message delivery. This adapter owns command parsing, Control Plane calls, approval state, and result aggregation.
