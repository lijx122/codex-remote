#!/usr/bin/env node
"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { createWxBotAdapter } = require("../src");

const host = process.env.WXBOT_HOST || "127.0.0.1";
const port = Number(process.env.WXBOT_PORT || 8790);
const outgoingWebhook = process.env.WXBOT_OUTGOING_WEBHOOK || "";
const outbox = [];

const adapter = createWxBotAdapter({
  controlPlaneUrl: process.env.CODEX_CONTROL_PLANE_URL || "http://127.0.0.1:8787",
  sendText: async (text) => {
    outbox.push({ ts: new Date().toISOString(), text });
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), direction: "out", text })}\n`);
    if (outgoingWebhook) {
      await fetch(outgoingWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      }).catch((error) => {
        process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), error: error.message })}\n`);
      });
    }
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/outbox") {
      sendJson(res, 200, outbox.slice(-100));
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const body = await readJson(req);
      const text = body.text || body.message || body.content || "";
      const before = outbox.length;
      await adapter.handleText(text);
      sendJson(res, 200, { ok: true, replies: outbox.slice(before) });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`codex-wxbot bridge listening on http://${host}:${port}\n`);
  process.stdout.write("POST /message {\"text\":\"/help\"}\n");
});

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
}
