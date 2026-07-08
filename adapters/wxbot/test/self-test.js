"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWxBotAdapter } = require("../src");
const { InboundMessageQueue } = require("../src/inbound-queue");
const { extractMediaItems, downloadMediaItems, parseAesKey } = require("../src/ilink-client");
const { splitMessage, summarizeAssistantMessage } = require("../src/message-utils");

class FakeClient {
  constructor() {
    this.events = new EventEmitter();
    this.sent = [];
    this.approvals = [];
    this.interrupted = [];
    this.threads = [
      { conversationId: "019ee451-eed0-7c21-b1a6-8e56d603e82b", title: "微信Adapter开发", updatedAt: new Date().toISOString(), sendable: true }
    ];
    this.assistantText = "Summary\n\n已完成微信 Adapter MVP。";
  }

  async listThreads() {
    return this.threads;
  }

  async loadHistory(conversationId) {
    return {
      conversationId,
      state: {
        turns: [
          {
            turnId: "t1",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "hello" }] },
              { type: "agentMessage", text: this.assistantText }
            ]
          }
        ]
      }
    };
  }

  async send(conversationId, message) {
    this.sent.push({ conversationId, message });
    return { ok: true };
  }

  async interrupt(conversationId) {
    this.interrupted.push(conversationId);
    return { ok: true };
  }

  async approve(conversationId, approvalId, decision) {
    this.approvals.push({ conversationId, approvalId, decision });
    return { ok: true };
  }

  connectEvents(conversationId, handlers) {
    this.handlers = handlers;
    return { close() {} };
  }
}

(async () => {
  const replies = [];
  let settledCount = 0;
  const client = new FakeClient();
  const adapter = createWxBotAdapter({
    client,
    now: () => Date.now(),
    sendText: async (text) => replies.push(text),
    maxMessageLength: 80,
    onTurnSettled: async () => { settledCount += 1; }
  });

  await adapter.handleText("/list");
  assert.match(replies.at(-1), /微信Adapter开发/);

  await adapter.handleText("/q 019ee451");
  assert.equal(adapter.currentConversationId, "019ee451-eed0-7c21-b1a6-8e56d603e82b");

  await adapter.handleText("修复 bug");
  assert.equal(client.sent[0].message, "修复 bug");
  assert.match(replies.at(-1), /运行中/);

  await adapter.handleEvent({ type: "approval_request", conversationId: adapter.currentConversationId, payload: { approvalId: "a1", raw: { command: "git push origin main" } } });
  assert.equal(adapter.pendingApprovalId, "a1");
  assert.match(replies.at(-1), /git push origin main/);

  await adapter.handleText("/y");
  assert.equal(client.approvals[0].decision, true);

  await adapter.handleEvent({ type: "turn_completed", conversationId: adapter.currentConversationId, payload: { turnId: "t1" } });
  assert.equal(settledCount, 1);
  assert.match(replies.at(-1), /已完成微信 Adapter MVP/);

  await adapter.handleText("/history");
  assert.match(replies.at(-1), /Summary/);

  assert.deepEqual(splitMessage("abc", 2), ["[1/2]\nab", "[2/2]\nc"]);
  assert.equal(summarizeAssistantMessage("## Summary\nhello\n\n## Next\nworld"), "hello");

  const mediaMessage = {
    message_type: 1,
    item_list: [
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "encrypted-param",
            aes_key: Buffer.from("00112233445566778899aabbccddeeff", "ascii").toString("base64")
          }
        }
      },
      {
        type: 4,
        file_item: {
          file_name: "report.pdf",
          media: {
            full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download/demo"
          }
        }
      },
      {
        type: 3,
        voice_item: {
          text: "voice transcript",
          media: {
            encrypt_query_param: "voice-param"
          }
        }
      },
      {
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: "video-param"
          }
        }
      }
    ]
  };
  const mediaItems = extractMediaItems(mediaMessage);
  assert.deepEqual(mediaItems.map(item => item.type), ["image", "file", "voice", "video"]);
  assert.equal(mediaItems[1].fileName, "report.pdf");
  assert.equal(mediaItems[2].transcript, "voice transcript");
  assert.equal(parseAesKey("00112233445566778899aabbccddeeff").length, 16);

  const key = parseAesKey(mediaItems[0].aesKey);
  const plaintext = Buffer.from("fake-jpeg-bytes");
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wxbot-media-"));
  const downloaded = await downloadMediaItems([mediaItems[0]], tmpDir, {
    fetch: async (url) => {
      assert.match(String(url), /encrypted_query_param=encrypted-param/);
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength)
      };
    }
  });
  assert.equal(downloaded.errors.length, 0);
  assert.equal(fs.readFileSync(downloaded.saved[0].path).toString(), "fake-jpeg-bytes");

  const dispatched = [];
  const queue = new InboundMessageQueue({
    mergeWindowMs: 0,
    settleDelayMs: 0,
    sendToCodex: async (item) => dispatched.push(item)
  });
  const target = { toUserId: "wxid_test", contextToken: "ctx" };
  const heldResult = queue.receive({
    target,
    saved: [{ type: "image", path: "C:\\tmp\\photo.jpg" }]
  });
  assert.equal(heldResult.status, "held");
  assert.equal(dispatched.length, 0);

  queue.receive({ target, text: "please inspect this image" });
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].payload, /please inspect this image/);
  assert.match(dispatched[0].payload, /photo\.jpg/);

  queue.receive({ target, text: "second message" });
  assert.equal(dispatched.length, 1);
  assert.equal(queue.queue.length, 1);
  queue.receive({
    target,
    saved: [{ type: "image", path: "C:\\tmp\\queued-photo.jpg" }]
  });
  assert.equal(queue.queue.length, 1);
  queue.markSettled();
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1].payload, /second message/);
  assert.match(dispatched[1].payload, /queued-photo\.jpg/);

  queue.receive({
    target,
    saved: [{ type: "file", fileName: "demo.pdf", path: "C:\\tmp\\demo.pdf" }]
  });
  assert.equal(dispatched.length, 2);
  queue.receive({
    target,
    text: "voice transcript",
    saved: [{ type: "voice", path: "C:\\tmp\\voice.silk", transcript: "voice transcript" }]
  });
  queue.markSettled();
  assert.equal(dispatched.length, 3);
  assert.doesNotMatch(dispatched[2].payload, /queued-photo\.jpg/);
  assert.match(dispatched[2].payload, /demo\.pdf/);
  assert.match(dispatched[2].payload, /voice\.silk/);
  assert.match(dispatched[2].payload, /Use the text content first/);
  assert.equal(dispatched[2].payload.split(/\r?\n/)[0], "voice transcript");
  assert.doesNotMatch(dispatched[2].payload, /channel transcript reference: voice transcript/);

  queue.receive({ target, text: "queued text A" });
  assert.equal(dispatched.length, 3);
  assert.equal(queue.queue.length, 1);
  queue.receive({
    target,
    text: "queued voice B",
    saved: [{ type: "voice", path: "C:\\tmp\\queued-b.silk", transcript: "queued voice B" }]
  });
  assert.equal(queue.queue.length, 1);
  queue.markSettled();
  assert.equal(dispatched.length, 4);
  assert.match(dispatched[3].payload, /queued text A/);
  assert.match(dispatched[3].payload, /queued-b\.silk/);

  let currentTime = 0;
  const staleDispatched = [];
  const staleQueue = new InboundMessageQueue({
    mergeWindowMs: 0,
    settleDelayMs: 0,
    pendingTtlMs: 100,
    pendingFileLimit: 1,
    now: () => currentTime,
    sendToCodex: async (item) => staleDispatched.push(item)
  });
  staleQueue.receive({
    target,
    saved: [
      { type: "image", path: "C:\\tmp\\old-a.jpg" },
      { type: "image", path: "C:\\tmp\\old-b.jpg" }
    ]
  });
  currentTime = 101;
  staleQueue.receive({ target, text: "handle old attachments" });
  assert.equal(staleDispatched.length, 1);
  assert.match(staleDispatched[0].payload, /old-a\.jpg/);
  assert.match(staleDispatched[0].payload, /old-b\.jpg/);
  assert.match(staleDispatched[0].payload, /Attachment context notes/);
  assert.match(staleDispatched[0].payload, /none were dropped/);

  const delayedDispatched = [];
  const timers = [];
  const delayedQueue = new InboundMessageQueue({
    mergeWindowMs: 0,
    settleDelayMs: 1000,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    sendToCodex: async (item) => delayedDispatched.push(item)
  });
  delayedQueue.receive({ target, text: "first" });
  delayedQueue.receive({ target, text: "second" });
  assert.equal(delayedDispatched.length, 1);
  delayedQueue.markSettled();
  assert.equal(delayedDispatched.length, 1);
  assert.equal(timers.at(-1).ms, 1000);
  timers.at(-1).fn();
  assert.equal(delayedDispatched.length, 2);
  assert.match(delayedDispatched[1].payload, /second/);

  const adaptiveTimers = [];
  const adaptiveQueue = new InboundMessageQueue({
    textMergeWindowMs: 8000,
    voiceMergeWindowMs: 30000,
    mediaMergeWindowMs: 30000,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      adaptiveTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    sendToCodex: async () => {}
  });
  adaptiveQueue.receive({ target, text: "text only" });
  assert.equal(adaptiveTimers.at(-1).ms, 8000);
  adaptiveQueue.receive({
    target,
    text: "voice text",
    saved: [{ type: "voice", path: "C:\\tmp\\adaptive.silk", transcript: "voice text" }]
  });
  assert.equal(adaptiveTimers.at(-1).ms, 30000);
  adaptiveQueue.flushAll();
  adaptiveQueue.markSettled();
  adaptiveQueue.receive({
    target,
    saved: [{ type: "image", path: "C:\\tmp\\adaptive.jpg" }]
  });
  adaptiveQueue.receive({ target, text: "with media" });
  assert.equal(adaptiveTimers.at(-1).ms, 30000);

  process.stdout.write("wxbot self-test passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
