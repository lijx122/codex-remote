#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Load .env from project root
(function loadEnv() {
  const envPath = path.resolve(__dirname, "..", "..", "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val && !process.env[key]) process.env[key] = val;
  }
})();

const { createControlPlaneServer } = require("../src");

const port = Number(process.env.CODEX_CONTROL_PLANE_PORT || process.argv[2] || "8787");
const host = process.env.CODEX_CONTROL_PLANE_HOST || "127.0.0.1";

async function main() {
  const controlPlane = createControlPlaneServer();
  const address = await controlPlane.listen(port, host);
  console.log(`codex-control-plane listening on ${address.address}:${address.port}`);
  console.log(`REST: http://${address.address}:${address.port}`);
  console.log(`WS:   ws://${address.address}:${address.port}/events?conversationId=<id>`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
