#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { createWxBotAdapter } = require("../src");

const adapter = createWxBotAdapter({
  controlPlaneUrl: process.env.CODEX_CONTROL_PLANE_URL || "http://127.0.0.1:8787",
  sendText: async (text) => {
    process.stdout.write(`\n[WECHAT OUT]\n${text}\n\n`);
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "wechat> "
});

process.stdout.write("Codex WeChat Adapter console\n");
process.stdout.write("Type /help, /list, /q <id>, or a normal message.\n\n");
rl.prompt();

rl.on("line", async (line) => {
  await adapter.handleText(line);
  rl.prompt();
});

rl.on("close", () => {
  process.stdout.write("\nbye\n");
});
