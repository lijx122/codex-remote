"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWxBotAdapter } = require("../src");
const { InboundMessageQueue } = require("../src/inbound-queue");
const { extractMediaItems, downloadMediaItems, ILinkClient, parseAesKey } = require("../src/ilink-client");
const { splitMessage, summarizeAssistantMessage, turnsFromState } = require("../src/message-utils");

class FakeClient {
  constructor() {
    this.events = new EventEmitter();
    this.sent = [];
    this.approvals = [];
    this.interrupted = [];
    this.sockets = [];
    this.threads = [
      { conversationId: "019ee451-eed0-7c21-b1a6-8e56d603e82b", title: "微信Adapter开发", updatedAt: new Date().toISOString(), sendable: true }
    ];
    this.assistantText = "Summary\n\n已完成微信 Adapter MVP。";
    this.turnStatus = "completed";
    this.warmMode = "ok";
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
            status: this.turnStatus,
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

  async warm(conversationId) {
    if (this.warmMode === "timeout") return { ok: false, timeout: true };
    if (this.warmMode === "offline") throw new Error("Desktop 当前离线");
    return { ok: true, sendable: true, conversationId };
  }

  async approve(conversationId, approvalId, decision) {
    this.approvals.push({ conversationId, approvalId, decision });
    return { ok: true };
  }

  connectEvents(conversationId, handlers) {
    this.handlers = handlers;
    const socket = {
      close: () => {
        if (handlers.close) handlers.close();
      }
    };
    this.sockets.push(socket);
    return socket;
  }
}

(async () => {
  const replies = [];
  let settledCount = 0;
  const client = new FakeClient();
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-wxbot-state-")), "wxbot-state.json");
  const adapter = createWxBotAdapter({
    client,
    now: () => Date.now(),
    sendText: async (text) => replies.push(text),
    sendFile: async (filePath) => ({ fileName: path.basename(filePath), size: 1234, path: filePath }),
    maxMessageLength: 80,
    onTurnSettled: async () => { settledCount += 1; },
    stateFile
  });

  await adapter.handleText("/list");
  assert.match(replies.at(-1), /微信Adapter开发/);

  await adapter.handleText("/q 019ee451");
  assert.equal(adapter.currentConversationId, "019ee451-eed0-7c21-b1a6-8e56d603e82b");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).currentConversationId, adapter.currentConversationId);

  client.threads.push({
    conversationId: "22222222-2222-4222-8222-222222222222",
    title: "warm timeout",
    updatedAt: new Date().toISOString(),
    sendable: false
  });
  client.warmMode = "timeout";
  await adapter.handleText("/q 2");
  assert.equal(adapter.currentConversationId, "22222222-2222-4222-8222-222222222222");
  assert.equal(adapter.currentThread.warmUnconfirmed, true);
  assert.equal(adapter.currentThread.sendable, false);

  client.threads.push({
    conversationId: "33333333-3333-4333-8333-333333333333",
    title: "warm offline",
    updatedAt: new Date().toISOString(),
    sendable: false
  });
  client.warmMode = "offline";
  await adapter.handleText("/q 3");
  assert.equal(adapter.currentConversationId, "33333333-3333-4333-8333-333333333333");
  assert.equal(adapter.currentThread.warmUnconfirmed, true);
  assert.equal(adapter.currentThread.sendable, false);

  client.warmMode = "ok";
  await adapter.handleText("/q 1");
  assert.equal(adapter.currentConversationId, "019ee451-eed0-7c21-b1a6-8e56d603e82b");

  const restoredAdapter = createWxBotAdapter({
    client,
    sendText: async (text) => replies.push(text),
    stateFile
  });
  assert.equal(restoredAdapter.currentConversationId, adapter.currentConversationId);
  const socketsBeforeSend = client.sockets.length;

  await adapter.handleText("修复 bug");
  assert.equal(client.sent[0].message, "修复 bug");
  assert.match(replies.at(-1), /运行中/);

  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(client.sockets.length, socketsBeforeSend + 1, "replacing an event socket must not schedule a reconnect");

  await adapter.handleEvent({ type: "approval_request", conversationId: adapter.currentConversationId, payload: { approvalId: "a1", raw: { command: "git push origin main" } } });
  assert.equal(adapter.pendingApprovalId, "a1");
  const approvalPromptCount = replies.length;
  await adapter.handleEvent({ type: "approval_request", conversationId: adapter.currentConversationId, payload: { approvalId: "a1", raw: { command: "git push origin main" } } });
  assert.equal(replies.length, approvalPromptCount, "duplicate approval requests must not duplicate iLink prompts");
  assert.match(replies.at(-1), /git push origin main/);

  await adapter.handleText("/y");
  assert.equal(client.approvals[0].decision, true);

  await adapter.handleEvent({ type: "turn_started", conversationId: adapter.currentConversationId, payload: { turnId: "t1" } });
  await adapter.handleEvent({ type: "turn_completed", conversationId: adapter.currentConversationId, payload: { turnId: "t1" } });
  assert.equal(settledCount, 1);
  assert.match(replies.at(-1), /已完成微信 Adapter MVP/);

  client.turnStatus = "running";
  let reconciled = await adapter.reconcileCurrentTurnState();
  assert.equal(reconciled.running, true);
  assert.equal(settledCount, 1);

  client.turnStatus = "interrupted";
  reconciled = await adapter.reconcileCurrentTurnState();
  assert.equal(reconciled.running, false);
  assert.equal(settledCount, 2);

  client.loadHistory = async (conversationId) => ({
    conversationId,
    state: canonicalState("completed", client.assistantText)
  });
  const repliesBeforeHistoricalReconcile = replies.length;
  reconciled = await adapter.reconcileCurrentTurnState();
  assert.equal(reconciled.running, false);
  assert.equal(reconciled.status, "completed");
  assert.equal(settledCount, 2);
  assert.equal(replies.length, repliesBeforeHistoricalReconcile);

  const repliesBeforeDuplicateReconcile = replies.length;
  reconciled = await adapter.reconcileCurrentTurnState();
  assert.equal(reconciled.running, false);
  assert.equal(reconciled.status, "completed");
  assert.equal(replies.length, repliesBeforeDuplicateReconcile);
  assert.equal(settledCount, 2);

  client.loadHistory = async (conversationId) => ({
    conversationId,
    state: canonicalState("running", client.assistantText)
  });
  reconciled = await adapter.reconcileCurrentTurnState();
  assert.equal(reconciled.running, true);
  assert.equal(settledCount, 2);

  const settledBeforeActiveInterrupt = settledCount;
  await adapter.handleText("interrupt this turn");
  await adapter.handleEvent({ type: "turn_started", conversationId: adapter.currentConversationId, payload: { turnId: "t2" } });
  await adapter.handleEvent({ type: "turn_interrupted", conversationId: adapter.currentConversationId, payload: { turnId: "t2", status: "interrupted" } });
  assert.equal(settledCount, settledBeforeActiveInterrupt + 1);

  await adapter.handleText("/history");
  assert.match(replies.at(-1), /Summary/);

  await adapter.handleText('/sendfile "C:\\tmp\\result screenshot.png"');
  assert.match(replies.at(-1), /result screenshot\.png/);
  assert.match(replies.at(-1), /1\.2 KB/);

  assert.deepEqual(splitMessage("abc", 2), ["[1/2]\nab", "[2/2]\nc"]);
  assert.equal(summarizeAssistantMessage("## Summary\nhello\n\n## Next\nworld"), "hello");
  assert.equal(turnsFromState(canonicalState("completed", "done")).at(-1).status, "completed");
  client.assistantText = "old final";
  client.loadHistory = async (conversationId) => ({
    conversationId,
    state: canonicalStateWithMessages([
      { type: "agentMessage", text: "Handoff: continue in the next session.", phase: "final_answer" },
      { type: "agentMessage", text: "同一轮真正的最终答复。", phase: "final_answer" }
    ])
  });
  await adapter.handleText("test two final messages");
  await adapter.handleEvent({ type: "turn_started", conversationId: adapter.currentConversationId, payload: { turnId: "new-final-turn" } });
  const repliesBeforeTwoFinals = replies.length;
  await adapter.handleEvent({ type: "turn_completed", conversationId: adapter.currentConversationId, payload: { turnId: "new-final-turn" } });
  assert.equal(replies.length, repliesBeforeTwoFinals + 1);
  assert.match(replies.at(-1), /同一轮真正的最终答复/);
  assert.doesNotMatch(replies.at(-1), /Handoff/);

  client.loadHistory = async (conversationId) => ({
    conversationId,
    state: stateWithTurns([
      {
        turnId: "earlier-completed-turn",
        turnStartedAtMs: 100,
        status: "completed",
        items: [{ type: "agentMessage", text: "较早轮的最终答复。", phase: "final_answer" }]
      },
      {
        turnId: "newer-completed-turn",
        turnStartedAtMs: 200,
        status: "completed",
        items: [{ type: "agentMessage", text: "较新轮的全局最终答复。", phase: "final_answer" }]
      }
    ])
  });
  await adapter.handleText("test payload turn id");
  await adapter.handleEvent({ type: "turn_started", conversationId: adapter.currentConversationId, payload: { turnId: "earlier-completed-turn" } });
  const repliesBeforeEarlierPayload = replies.length;
  await adapter.handleEvent({
    type: "turn_completed",
    conversationId: adapter.currentConversationId,
    payload: { turnId: "earlier-completed-turn" }
  });
  assert.equal(replies.length, repliesBeforeEarlierPayload + 1);
  assert.match(replies.at(-1), /较早轮的最终答复/);
  assert.doesNotMatch(replies.at(-1), /较新轮的全局最终答复/);

  const activeReplies = [];
  const activeSettlements = [];
  const activeClient = new FakeClient();
  const activeAdapter = createWxBotAdapter({
    client: activeClient,
    sendText: async (text) => activeReplies.push(text),
    onTurnSettled: async (event) => activeSettlements.push(event),
    logger: { info() {}, warn() {} }
  });
  await activeAdapter.handleText("/q 1");
  await activeAdapter.handleText("start active turn reconciliation");
  activeClient.loadHistory = async (conversationId) => ({
    conversationId,
    state: stateWithTurns([
      {
        turnId: "historical-turn",
        turnStartedAtMs: 100,
        status: "completed",
        items: [{ type: "agentMessage", text: "historical reply", phase: "final_answer" }]
      },
      {
        turnId: "active-turn",
        turnStartedAtMs: 200,
        status: "completed",
        items: [{ type: "agentMessage", text: "active turn reply", phase: "final_answer" }]
      }
    ])
  });

  const repliesBeforeHistoricalCompletion = activeReplies.length;
  await activeAdapter.handleEvent({
    type: "turn_completed",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "historical-turn" }
  });
  assert.equal(activeReplies.length, repliesBeforeHistoricalCompletion);
  assert.equal(activeSettlements.length, 0);

  await activeAdapter.handleEvent({
    type: "turn_started",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "active-turn" }
  });
  await activeAdapter.handleEvent({
    type: "turn_completed",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "historical-turn" }
  });
  assert.equal(activeReplies.length, repliesBeforeHistoricalCompletion);
  assert.equal(activeSettlements.length, 0);

  await activeAdapter.handleEvent({
    type: "turn_completed",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "active-turn" }
  });
  assert.equal(activeReplies.length, repliesBeforeHistoricalCompletion + 1);
  assert.match(activeReplies.at(-1), /active turn reply/);
  assert.equal(activeSettlements.length, 1);
  assert.equal(activeSettlements[0].turnId, "active-turn");

  await activeAdapter.handleText("start history failure turn");
  await activeAdapter.handleEvent({
    type: "turn_started",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "history-error-turn" }
  });
  activeClient.loadHistory = async () => { throw new Error("history unavailable"); };
  await activeAdapter.handleEvent({
    type: "turn_completed",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "history-error-turn" }
  });
  assert.equal(activeSettlements.length, 1);

  await activeAdapter.handleEvent({
    type: "turn_interrupted",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "other-turn", status: "interrupted" }
  });
  assert.equal(activeSettlements.length, 1);
  await activeAdapter.handleEvent({
    type: "turn_interrupted",
    conversationId: activeAdapter.currentConversationId,
    payload: { turnId: "history-error-turn", status: "interrupted" }
  });
  assert.equal(activeSettlements.length, 2);
  assert.equal(activeSettlements[1].turnId, "history-error-turn");

  const raceClient = new FakeClient();
  const raceAdapter = createWxBotAdapter({
    client: raceClient,
    sendText: async () => {},
    logger: { info() {}, warn() {} }
  });
  await raceAdapter.handleText("/q 1");
  raceClient.send = async (conversationId, message) => {
    raceClient.sent.push({ conversationId, message });
    await raceAdapter.handleEvent({
      type: "turn_started",
      conversationId,
      payload: { turnId: "fast-start-turn" }
    });
    return { ok: true };
  };
  await raceAdapter.handleText("fast start race");
  assert.equal(raceAdapter.awaitingTurnStart, false);
  assert.equal(raceAdapter.activeTurnId, "fast-start-turn");
  raceClient.threads.push({
    conversationId: "44444444-4444-4444-8444-444444444444",
    title: "must not switch while active",
    updatedAt: new Date().toISOString(),
    sendable: true
  });
  const raceConversationId = raceAdapter.currentConversationId;
  await raceAdapter.handleText("/q 2");
  assert.equal(raceAdapter.currentConversationId, raceConversationId);

  const failedReplies = [];
  const failedWarnings = [];
  const failedSettlements = [];
  const failedClient = new FakeClient();
  let rejectReplies = false;
  const failedAdapter = createWxBotAdapter({
    client: failedClient,
    sendText: async (text) => {
      if (rejectReplies) throw new Error("iLink sendmessage error: ret=-2");
      failedReplies.push(text);
    },
    onTurnSettled: async (event) => failedSettlements.push(event),
    logger: {
      info() {},
      warn(event) { failedWarnings.push(event); }
    }
  });
  await failedAdapter.handleText("/q 1");
  await failedAdapter.handleText("reply failure turn");
  await failedAdapter.handleEvent({
    type: "turn_started",
    conversationId: failedAdapter.currentConversationId,
    payload: { turnId: "reply-failure-turn" }
  });
  failedClient.loadHistory = async (conversationId) => ({
    conversationId,
    state: stateWithTurns([{
      turnId: "reply-failure-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "reply that cannot be delivered", phase: "final_answer" }]
    }])
  });
  rejectReplies = true;
  await failedAdapter.handleEvent({
    type: "turn_completed",
    conversationId: failedAdapter.currentConversationId,
    payload: { turnId: "reply-failure-turn" }
  });
  assert.equal(failedSettlements.length, 1);
  assert.equal(failedSettlements[0].reason, "reply_failed");
  assert.equal(failedAdapter.activeTurnId, "");
  assert.equal(failedWarnings.some((event) => event.status === "reply_failed"), true);

  const eventFailureWarnings = [];
  const eventFailureClient = new FakeClient();
  let eventFailureReject = false;
  const eventFailureAdapter = createWxBotAdapter({
    client: eventFailureClient,
    sendText: async () => {
      if (eventFailureReject) throw new Error("iLink sendmessage error: ret=-2");
    },
    logger: { info() {}, warn(event) { eventFailureWarnings.push(event); } }
  });
  await eventFailureAdapter.handleText("/q 1");
  eventFailureReject = true;
  eventFailureClient.handlers.message({
    type: "approval_request",
    conversationId: eventFailureAdapter.currentConversationId,
    payload: { approvalId: "approval-failure", raw: { command: "echo test" } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventFailureWarnings.some((event) => event.status === "event_handler_failed"), true);

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

  const uploadFilePath = path.join(tmpDir, "result.png");
  fs.writeFileSync(uploadFilePath, Buffer.from("fake-png-bytes"));
  const uploadRequests = [];
  const uploadClient = new ILinkClient({
    baseUrl: "https://ilink.test",
    cdnBaseUrl: "https://cdn.test/c2c",
    fetch: async (url, options = {}) => {
      uploadRequests.push({ url: String(url), body: options.body ? String(options.body) : "", headers: options.headers || {} });
      if (String(url).includes("/ilink/bot/getuploadurl")) {
        const body = JSON.parse(options.body);
        assert.equal(body.media_type, 1);
        assert.equal(body.to_user_id, "wxid_test");
        assert.equal(body.rawsize, Buffer.byteLength("fake-png-bytes"));
        assert.ok(body.aeskey);
        assert.equal(body.base_info.channel_version, "2.2.0");
        assert.equal(options.headers["iLink-App-Id"], "bot");
        return {
          ok: true,
          status: 200,
          json: async () => ({ upload_param: "upload-param", upload_full_url: "https://cdn.test/direct-upload" })
        };
      }
      if (String(url).includes("/upload?")) {
        throw new Error("expected upload_full_url to be preferred");
      }
      if (String(url) === "https://cdn.test/direct-upload") {
        return {
          ok: true,
          status: 200,
          headers: new Map([["x-encrypted-param", "download-param"]]),
          text: async () => ""
        };
      }
      if (String(url).includes("/ilink/bot/sendmessage")) {
        const body = JSON.parse(options.body);
        assert.equal(body.msg.to_user_id, "wxid_test");
        assert.equal(body.msg.item_list[0].type, 2);
        assert.equal(body.msg.item_list[0].image_item.media.encrypt_query_param, "download-param");
        assert.equal(body.msg.item_list[0].image_item.media.aes_key.length, 44);
        const apiKeyDecoded = Buffer.from(body.msg.item_list[0].image_item.media.aes_key, "base64").toString("ascii");
        assert.match(apiKeyDecoded, /^[0-9a-f]{32}$/);
        assert.equal(body.base_info.channel_version, "2.2.0");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ret: 0 })
        };
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });
  await uploadClient.sendLocalFileMessage("token", "wxid_test", uploadFilePath, "ctx");
  assert.equal(uploadRequests.length, 3);

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

function canonicalState(status, assistantText) {
  return {
    turns: [],
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: {
          "turn:t1": {
            turnId: "t1",
            turnStartedAtMs: 100,
            status,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "hello" }] },
              { type: "agentMessage", text: assistantText }
            ]
          }
        }
      }
    }
  };
}

function canonicalStateWithMessages(items) {
  return {
    turns: [
      {
        turnId: "new-final-turn",
        status: "completed",
        items
      }
    ]
  };
}

function stateWithTurns(turns) {
  return {
    turns: [],
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: Object.fromEntries(turns.map((turn) => [`turn:${turn.turnId}`, turn]))
      }
    }
  };
}
