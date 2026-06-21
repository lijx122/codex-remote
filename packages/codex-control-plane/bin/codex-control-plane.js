#!/usr/bin/env node
"use strict";

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
