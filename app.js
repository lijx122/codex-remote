"use strict";

// Codex Remote — single entry point that starts all services.
// Web UI: http://127.0.0.1:8787
// WeChat: auto-poll via iLink bot

const path = require("path");
const fs = require("fs");

// Redirect runtime data to user home so it survives exe updates
const runtimeDir = process.env.CODEX_REMOTE_RUNTIME_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || __dirname, ".codex-remote-data");
if (!fs.existsSync(runtimeDir)) {
  fs.mkdirSync(runtimeDir, { recursive: true });
}
process.env.CODEX_REMOTE_RUNTIME_DIR = runtimeDir;

console.log("Codex Remote starting...");
console.log(`Web UI: http://127.0.0.1:${process.env.CODEX_CONTROL_PLANE_PORT || 8787}`);

// Start control-plane (REST + WebSocket + static Web UI)
require("./tools/codex-control-plane.js");

// Start WeChat iLink bot (deferred to next tick so control-plane is ready)
setImmediate(() => {
  require("./adapters/wxbot/bin/ilink.js");
});
