"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createControlPlaneServer } = require("../src/server");

class FakeCore {
  constructor() {
    this.connected = false;
    this.sendAttempts = 0;
    this.warmAttempts = 0;
  }

  async connect() {
    this.connected = true;
    return { clientId: "fake" };
  }

  disconnect() {}

  async sendMessage(conversationId, message) {
    this.sendAttempts += 1;
    assert.equal(conversationId, "thread-1");
    assert.equal(message, "hello");
    if (this.sendAttempts < 3) throw new Error("no-client-found");
    return { ok: true, raw: { attempt: this.sendAttempts } };
  }

  async warmThread(conversationId) {
    this.warmAttempts += 1;
    assert.equal(conversationId, "thread-1");
    return { ok: true, sendable: true };
  }

  subscribeEvents() {
    return { on() {}, unsubscribe() {} };
  }
}

(async () => {
  const core = new FakeCore();
  const app = createControlPlaneServer({ core });
  const address = await app.listen(0, "127.0.0.1");
  try {
    const response = await postJson(address.port, "/send", {
      conversationId: "thread-1",
      message: "hello"
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(core.sendAttempts, 3);
    assert.equal(core.warmAttempts, 2);
  } finally {
    await app.close();
  }
  process.stdout.write("control-plane send retry test passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(raw)
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}
