"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createWxBotAdapter } = require("../src");
const { splitMessage, summarizeAssistantMessage } = require("../src/message-utils");

class FakeClient {
  constructor() {
    this.events = new EventEmitter();
    this.sent = [];
    this.approvals = [];
    this.interrupted = [];
    this.threads = [
      { conversationId: "019ee451-eed0-7c21-b1a6-8e56d603e82b", title: "微信Adapter开发", updatedAt: new Date().toISOString() }
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
  const client = new FakeClient();
  const adapter = createWxBotAdapter({
    client,
    now: () => Date.now(),
    sendText: async (text) => replies.push(text),
    maxMessageLength: 80
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
  assert.match(replies.at(-1), /任务完成/);
  assert.match(replies.at(-1), /已完成微信 Adapter MVP/);

  await adapter.handleText("/full");
  assert.match(replies.at(-1), /Summary/);

  assert.deepEqual(splitMessage("abc", 2), ["[1/2]\nab", "[2/2]\nc"]);
  assert.equal(summarizeAssistantMessage("## Summary\nhello\n\n## Next\nworld"), "hello");

  process.stdout.write("wxbot self-test passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
