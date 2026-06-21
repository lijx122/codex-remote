#!/usr/bin/env node
"use strict";

const { createCodexFollower } = require("../../codex-follower-core/src");

const DEFAULT_LISTEN_MS = Number(process.env.CODEX_FOLLOWER_LISTEN_MS || "3000");

function usage() {
  console.log(`Usage:
  codex-follower list
  codex-follower history <conversationId>
  codex-follower send <conversationId> "hello"
  codex-follower interrupt <conversationId>

Environment:
  CODEX_FOLLOWER_LISTEN_MS=3000`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withClient(fn) {
  const client = createCodexFollower();
  try {
    await client.connect();
    await fn(client);
  } finally {
    client.disconnect();
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "list") {
    await withClient(async (client) => {
      await wait(DEFAULT_LISTEN_MS);
      printJson(client.listThreads());
    });
    return;
  }

  if (command === "history") {
    const conversationId = process.argv[3];
    if (!conversationId) throw new Error("conversationId is required");
    await withClient(async (client) => {
      const result = await client.loadHistory(conversationId);
      printJson({
        conversationId,
        revision: result.revision,
        state: result.state
      });
    });
    return;
  }

  if (command === "send") {
    const conversationId = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!conversationId) throw new Error("conversationId is required");
    if (!text) throw new Error("message text is required");
    await withClient(async (client) => {
      const result = await client.sendMessage(conversationId, text);
      printJson(result);
    });
    return;
  }

  if (command === "interrupt") {
    const conversationId = process.argv[3];
    if (!conversationId) throw new Error("conversationId is required");
    await withClient(async (client) => {
      const result = await client.interrupt(conversationId);
      printJson(result);
    });
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.response) {
    console.error(JSON.stringify(error.response, null, 2));
  }
  process.exitCode = 1;
});
