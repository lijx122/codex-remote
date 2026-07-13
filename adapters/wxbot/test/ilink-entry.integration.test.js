"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");

const USER_ID = "o9cq809l";
const CONTEXT = "ctx-entry-test";
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";

class FakeControlPlane {
  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map();
    this.threads = [
      { conversationId: THREAD_A, title: "entry user", updatedAt: new Date().toISOString(), sendable: true },
      { conversationId: THREAD_B, title: "entry warm", updatedAt: new Date().toISOString(), sendable: false }
    ];
    this.histories = new Map();
    this.sendBodies = [];
    this.interruptBodies = [];
    this.approvals = [];
    this.turnNumber = 0;
    this.pending = new Map();
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/events") return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const id = url.searchParams.get("conversationId");
        const list = this.clients.get(id) || new Set();
        list.add(ws);
        this.clients.set(id, list);
        ws.on("close", () => list.delete(ws));
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  close() {
    this.wss.close();
    this.server.close();
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const body = await readBody(req);
      if (req.method === "GET" && url.pathname === "/health") return json(res, { ok: true, connected: true });
      if (req.method === "GET" && url.pathname === "/threads") return json(res, this.threads);
      if (req.method === "GET" && url.pathname.startsWith("/history/")) {
        return json(res, { conversationId: url.pathname.slice("/history/".length), state: this.history(url.pathname.slice("/history/".length)) });
      }
      if (req.method === "POST" && url.pathname === "/warm") {
        this.threads.find((thread) => thread.conversationId === THREAD_B).sendable = true;
        return json(res, { ok: true, conversationId: THREAD_B, sendable: true });
      }
      if (req.method === "POST" && url.pathname === "/send") return this.handleSend(body, res);
      if (req.method === "POST" && url.pathname === "/interrupt") {
        this.interruptBodies.push(body);
        this.broadcast(body.conversationId, { type: "turn_interrupted", conversationId: body.conversationId, payload: { turnId: this.currentTurn(body.conversationId), status: "interrupted" } });
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/approve") {
        this.approvals.push(body);
        const turnId = this.currentTurn(body.conversationId);
        this.complete(body.conversationId, turnId, "approved reply");
        return json(res, { ok: true });
      }
      return json(res, { error: `unknown control route ${req.method} ${url.pathname}` }, 404);
    } catch (error) {
      return json(res, { error: error.message }, 500);
    }
  }

  handleSend(body, res) {
    this.sendBodies.push(body);
    const id = body.conversationId;
    const turnId = `entry-turn-${++this.turnNumber}`;
    const message = String(body.message || "");
    this.pending.set(id, { turnId, message, status: "running", text: "" });
    this.broadcast(id, { type: "turn_started", conversationId: id, payload: { turnId } });
    if (message.includes("approval")) {
      setTimeout(() => this.broadcast(id, { type: "approval_request", conversationId: id, payload: { approvalId: "approval-entry-1", raw: { command: "echo approved" } } }), 20);
    } else if (!message.includes("long")) {
      setTimeout(() => this.complete(id, turnId, `reply:${message.slice(0, 80)}`), 50);
    }
    return json(res, { ok: true, raw: { accepted: true, turnId } });
  }

  currentTurn(id) {
    return this.pending.get(id)?.turnId || "unknown-turn";
  }

  complete(id, turnId, text) {
    const pending = this.pending.get(id);
    if (!pending || pending.turnId !== turnId) return;
    pending.status = "completed";
    pending.text = text;
    this.broadcast(id, { type: "turn_completed", conversationId: id, payload: { turnId } });
  }

  history(id) {
    const pending = this.pending.get(id);
    if (!pending) return { turns: [] };
    const items = [{ type: "userMessage", content: [{ type: "text", text: pending.message }] }];
    if (pending.text) items.push({ type: "agentMessage", text: pending.text, phase: "final_answer" });
    return { turns: [{ turnId: pending.turnId, status: pending.status, items }] };
  }

  broadcast(id, event) {
    const payload = {
      ...(event.payload && typeof event.payload === "object" ? event.payload : {}),
      ...Object.fromEntries(Object.entries(event).filter(([key]) => !["type", "conversationId", "payload"].includes(key)))
    };
    const wireEvent = {
      type: [
        "message",
        "turn_started",
        "turn_completed",
        "turn_interrupted",
        "approval_request",
        "approval_response",
        "interrupt",
        "thread_state_changed",
        "diagnostic",
        "error"
      ].includes(event.type) ? event.type : "error",
      conversationId: event.conversationId || null,
      payload
    };
    for (const ws of this.clients.get(id) || []) {
      if (ws.readyState === 1) ws.send(JSON.stringify(wireEvent));
    }
  }
}

class FakeILink {
  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.messages = [];
    this.sent = [];
    this.downloads = new Map();
    this.uploads = [];
    this.updateCalls = 0;
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
    return this.baseUrl;
  }

  close() { this.server.close(); }

  enqueue(...messages) { this.messages.push(...messages.flat()); }

  async handle(req, res) {
    const url = new URL(req.url, this.baseUrl || "http://127.0.0.1");
    const body = await readBody(req);
    if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
      this.updateCalls += 1;
      await delay(10);
      const msgs = this.messages.splice(0);
      return json(res, { ret: 0, msgs, get_updates_buf: `cursor-${this.updateCalls}` });
    }
    if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
      this.sent.push(body);
      return json(res, { ret: 0 });
    }
    if (req.method === "POST" && url.pathname === "/ilink/bot/getuploadurl") {
      return json(res, { ret: 0, upload_full_url: `${this.baseUrl}/upload` });
    }
    if (req.method === "POST" && url.pathname === "/upload") {
      this.uploads.push(body);
      res.writeHead(200, { "x-encrypted-param": "uploaded-entry" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/download") {
      const query = url.searchParams.get("encrypted_query_param");
      if (query === "fail-entry") return json(res, { error: "download failure" }, 500);
      const item = this.downloads.get(query);
      if (!item) return json(res, { error: "missing media" }, 404);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": item.ciphertext.length });
      return res.end(item.ciphertext);
    }
    return json(res, { ret: 0 });
  }

  addMedia(query, text, keyHex = "00112233445566778899aabbccddeeff") {
    const key = Buffer.from(keyHex, "hex");
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
    this.downloads.set(query, { ciphertext });
    return { encrypt_query_param: query, aes_key: Buffer.from(keyHex, "ascii").toString("base64") };
  }
}

function textMessage(text, msgId = "") {
  return {
    ...(msgId ? { msg_id: msgId } : {}),
    from_user_id: USER_ID,
    context_token: CONTEXT,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }]
  };
}

function mediaMessage(type, media, extra = {}) {
  const item = type === 2 ? { type, image_item: { media } }
    : type === 3 ? { type, voice_item: { text: extra.text || "", media } }
      : type === 4 ? { type, file_item: { file_name: extra.fileName || "entry.pdf", media } }
        : { type, video_item: { media } };
  return { from_user_id: USER_ID, context_token: CONTEXT, message_type: 1, item_list: [item] };
}

async function run() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ilink-entry-"));
  const control = new FakeControlPlane();
  const ilink = new FakeILink();
  const controlUrl = await control.start();
  const ilinkUrl = await ilink.start();
  const media = {
    image: ilink.addMedia("image-entry", "image-bytes"),
    voice: ilink.addMedia("voice-entry", "voice-bytes"),
    file: ilink.addMedia("file-entry", "file-bytes"),
    video: ilink.addMedia("video-entry", "video-bytes")
  };
  const filePath = path.join(runtimeDir, "sendfile-result.png");
  fs.writeFileSync(filePath, "sendfile-bytes");
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "bin", "ilink.js")], {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    env: {
      ...process.env,
      ILINK_BOT_TOKEN: "entry-test-token",
      ILINK_BASE_URL: ilinkUrl,
      WEIXIN_CDN_BASE_URL: ilinkUrl,
      ILINK_ALLOW_INSECURE_MEDIA: "1",
      CODEX_CONTROL_PLANE_URL: controlUrl,
      CODEX_REMOTE_RUNTIME_DIR: runtimeDir,
      WXBOT_TEXT_MERGE_WINDOW_MS: "0",
      WXBOT_VOICE_MERGE_WINDOW_MS: "0",
      WXBOT_MEDIA_MERGE_WINDOW_MS: "0",
      WXBOT_RECONCILE_INTERVAL_MS: "100"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitFor(() => stdout.includes("Polling messages"), 10000, "ilink child startup");

    ilink.enqueue(textMessage("/help"));
    await waitFor(() => hasText(ilink.sent, "/sendfile"), 5000, "/help");

    ilink.enqueue(textMessage("/ls all"));
    await waitFor(() => hasText(ilink.sent, "entry warm"), 5000, "/ls all");

    ilink.enqueue(textMessage("/q 2"));
    await waitFor(() => hasText(ilink.sent, "切换完成"), 5000, "/q warm completion");

    ilink.enqueue(textMessage("/where"));
    await waitFor(() => hasText(ilink.sent, THREAD_B), 5000, "/where");

    ilink.enqueue(textMessage("hello entry"));
    await waitFor(() => control.sendBodies.some((entry) => entry.message === "hello entry"), 5000, "text dispatch");
    await waitFor(() => hasText(ilink.sent, "reply:hello entry"), 5000, "text reply");

    const sentBeforeDiagnostic = ilink.sent.length;
    control.broadcast(THREAD_B, {
      type: "diagnostic",
      conversationId: THREAD_B,
      code: "stream-patch-failed",
      message: "array add index is out of range",
      error: { message: "array add index is out of range" }
    });
    await delay(250);
    assert.equal(
      hasText(ilink.sent.slice(sentBeforeDiagnostic), "array add index is out of range"),
      false,
      "internal stream diagnostics must not be sent as iLink execution failures"
    );

    const sendCountBeforeDuplicate = control.sendBodies.length;
    ilink.enqueue(textMessage("duplicate entry", "duplicate-entry-1"), textMessage("duplicate entry", "duplicate-entry-1"));
    await waitFor(() => control.sendBodies.length >= sendCountBeforeDuplicate + 1, 5000, "duplicate dispatch");
    await delay(250);
    assert.equal(control.sendBodies.length, sendCountBeforeDuplicate + 1, "duplicate msg_id must dispatch once");

    ilink.enqueue(
      mediaMessage(2, media.image),
      mediaMessage(4, media.file, { fileName: "entry.pdf" }),
      mediaMessage(5, media.video),
      mediaMessage(3, media.voice, { text: "voice entry transcript" })
    );
    await waitFor(() => control.sendBodies.some((entry) => entry.message.includes("voice entry transcript") && entry.message.includes("entry.pdf") && entry.message.includes(".mp4")), 10000, "media grouping");
    const grouped = control.sendBodies.find((entry) => entry.message.includes("voice entry transcript"));
    assert.match(grouped.message, /Use the text content first/);
    assert.match(grouped.message, /image/);
    assert.match(grouped.message, /file/);
    assert.match(grouped.message, /video/);

    ilink.enqueue(mediaMessage(2, { ...media.image, encrypt_query_param: "fail-entry" }), textMessage("download failure trigger"));
    await waitFor(() => control.sendBodies.some((entry) => entry.message.includes("Attachment save failures")), 10000, "media failure fallback");

    ilink.enqueue(textMessage(`/sendfile "${filePath}"`));
    await waitFor(() => ilink.sent.some((entry) => entry.msg && entry.msg.item_list && entry.msg.item_list[0].type !== 1), 10000, "/sendfile upload");
    await waitFor(() => hasText(ilink.sent, "已发送文件"), 5000, "/sendfile confirmation");

    ilink.enqueue(textMessage("long entry job"));
    await waitFor(() => control.sendBodies.some((entry) => entry.message === "long entry job"), 5000, "long dispatch");
    ilink.enqueue(textMessage("/stop"));
    await waitFor(() => control.interruptBodies.length > 0 && hasText(ilink.sent, "已发送中断请求"), 5000, "/stop");

    ilink.enqueue(textMessage("approval entry job"));
    await waitFor(() => hasText(ilink.sent, "需要审批"), 5000, "approval request");
    ilink.enqueue(textMessage("/y"));
    await waitFor(() => control.approvals.length === 1 && hasText(ilink.sent, "已批准"), 5000, "approval response");

    ilink.enqueue(textMessage("/history"));
    await waitFor(() => hasText(ilink.sent, "Assistant"), 5000, "/history");

    ilink.enqueue(textMessage("/unknown-entry-command"));
    await waitFor(() => hasText(ilink.sent, "未知命令"), 5000, "unknown command");

    const log = fs.readFileSync(path.join(runtimeDir, "wxbot-runtime.jsonl"), "utf8");
    assert.match(log, /"status":"received"/);
    assert.match(log, /"status":"sent"/);
    assert.doesNotMatch(log, /entry-test-token/);
    const cursor = JSON.parse(fs.readFileSync(path.join(runtimeDir, "ilink-updates-state.json"), "utf8"));
    assert.match(cursor.getUpdatesBuf, /^cursor-/);
    process.stdout.write("ilink entry integration passed\n");
  } catch (error) {
    process.stderr.write(`integration failure: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}\n`);
    throw error;
  } finally {
    child.kill("SIGINT");
    await delay(300);
    if (!child.killed) child.kill("SIGKILL");
    control.close();
    ilink.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function hasText(sent, text) {
  return sent.some((entry) => entry.msg && entry.msg.item_list && entry.msg.item_list.some((item) => item.text_item && String(item.text_item.text).includes(text)));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url && req.url.includes("/upload")) return resolve(raw);
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw.toString("utf8"))); } catch { resolve({}); }
    });
  });
}

function json(res, value, status = 200) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

run().catch(() => process.exit(1));
