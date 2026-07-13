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

const { createWxBotAdapter } = require("../src");
const { InboundMessageQueue } = require("../src/inbound-queue");
const { ILinkClient, textFromIlinkMessage, extractMediaItems } = require("../src/ilink-client");
const { saveLastTarget, sendFileFromRuntime } = require("../src/sendfile-service");

const ilinkClient = new ILinkClient();
const controlPlaneUrl = process.env.CODEX_CONTROL_PLANE_URL || "http://127.0.0.1:8787";

const RUNTIME_DIR = process.env.CODEX_REMOTE_RUNTIME_DIR || path.resolve(__dirname, "..", ".runtime");
const TOKEN_FILE = path.join(RUNTIME_DIR, "ilink-bot-token.json");
const UPDATES_STATE_FILE = path.join(RUNTIME_DIR, "ilink-updates-state.json");
const WXBOT_STATE_FILE = path.join(RUNTIME_DIR, "wxbot-state.json");
const WXBOT_RUNTIME_LOG_FILE = path.join(RUNTIME_DIR, "wxbot-runtime.jsonl");
const MEDIA_DIR = path.join(RUNTIME_DIR, "media");
const RECONCILE_MIN_BUSY_MS = Number(process.env.WXBOT_RECONCILE_MIN_BUSY_MS || 2000);
const RECONCILE_INTERVAL_MS = Number(process.env.WXBOT_RECONCILE_INTERVAL_MS || 3000);

let botToken = process.env.ILINK_BOT_TOKEN || loadTokenFromFile();
let getUpdatesBuf = loadUpdatesCursor();
let currentTarget = null;
let replyTarget = null;
let stopping = false;
let reconcileInFlight = false;
const processedInboundMessages = new Map();
const INBOUND_DEDUP_TTL_MS = 30 * 60 * 1000;
const INBOUND_DEDUP_MAX = 2000;

const runtimeLogger = {
  info: (...args) => writeAdapterLog("info", args),
  warn: (...args) => writeAdapterLog("warn", args),
  error: (...args) => writeAdapterLog("error", args)
};

function writeRuntimeEvent(event, stream = process.stdout) {
  const entry = normalizeRuntimeEvent(event);
  const line = `${JSON.stringify(entry)}\n`;
  stream.write(line);
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(WXBOT_RUNTIME_LOG_FILE, line, "utf8");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ts: new Date().toISOString(),
      direction: "runtime",
      status: "log_write_failed",
      error: errorSummary(error)
    })}\n`);
  }
}

function normalizeRuntimeEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const normalized = { ts: source.ts || new Date().toISOString() };
  const stringFields = ["direction", "source", "level", "turnId", "phase", "status", "reason", "turnStatus"];
  const numericFields = ["length", "count", "held", "queued"];
  const booleanFields = ["busy", "running"];

  for (const key of stringFields) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      normalized[key] = String(source[key]).slice(0, 240);
    }
  }
  for (const key of ["from", "to", "conversationId"]) {
    if (source[key]) normalized[key] = shortId(source[key]);
  }
  for (const key of numericFields) {
    if (Number.isFinite(Number(source[key]))) normalized[key] = Number(source[key]);
  }
  for (const key of booleanFields) {
    if (typeof source[key] === "boolean") normalized[key] = source[key];
  }
  if (source.media) {
    normalized.media = Array.isArray(source.media)
      ? source.media.map((value) => String(value).slice(0, 40)).slice(0, 10)
      : String(source.media).slice(0, 80);
  }
  if (source.error) normalized.error = errorSummary(source.error);
  return normalized;
}

function writeAdapterLog(level, args) {
  const event = { direction: "adapter", level, status: "log" };
  const summaries = [];
  for (const arg of args) {
    if (arg && typeof arg === "object" && !(arg instanceof Error)) {
      for (const key of ["conversationId", "turnId", "phase", "length", "status", "error"]) {
        if (arg[key] !== undefined) event[key] = arg[key];
      }
    } else if (arg !== undefined) {
      summaries.push(errorSummary(arg));
    }
  }
  if (!event.error && summaries.length > 0) event.error = summaries.join(" | ");
  writeRuntimeEvent(event, level === "error" ? process.stderr : process.stdout);
}

function errorSummary(value) {
  const raw = value && value.message ? value.message : String(value || "unknown error");
  return raw
    .replace(/\r?\n/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(bot[_-]?token|context[_-]?token|authorization)(?:\s*[:=]\s*|\s+)\S+/gi, "$1=[redacted]")
    .replace(/\b(wxid_[A-Za-z0-9_-]{8})[A-Za-z0-9_-]*/g, "$1...")
    .slice(0, 240);
}

function loadTokenFromFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (data.bot_token) {
        process.stdout.write(`Loaded saved bot_token from ${TOKEN_FILE}\n`);
        return data.bot_token;
      }
    }
  } catch (e) {
    // Ignore
  }
  return "";
}

function loadUpdatesCursor() {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATES_STATE_FILE, "utf8"));
    return String(data.getUpdatesBuf || data.syncBuf || "");
  } catch {
    return "";
  }
}

function saveUpdatesCursor(cursor) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(UPDATES_STATE_FILE, JSON.stringify({
      getUpdatesBuf: cursor,
      savedAt: new Date().toISOString()
    }, null, 2), "utf8");
  } catch (error) {
    writeRuntimeEvent({ direction: "runtime", status: "updates_cursor_save_failed", error }, process.stderr);
  }
}

function saveTokenToFile(token) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ bot_token: token, saved_at: new Date().toISOString() }, null, 2), "utf8");
    process.stdout.write(`Saved bot_token to ${TOKEN_FILE}\n`);
  } catch (e) {
    process.stderr.write(`Failed to save token: ${e.message}\n`);
  }
}

async function sendWechatText(target, text) {
  if (!botToken) {
    writeRuntimeEvent({ direction: "out", status: "skipped_not_logged_in", length: String(text || "").length });
    return;
  }
  if (!target || !target.toUserId) {
    writeRuntimeEvent({ direction: "out", status: "skipped_no_target", length: String(text || "").length });
    return;
  }

  try {
    await ilinkClient.sendTextMessage(botToken, target.toUserId, text, target.contextToken || "");
    writeRuntimeEvent({ direction: "out", to: target.toUserId, length: text.length, status: "sent" });
  } catch (e) {
    if (String(e.message).includes("401")) {
      writeRuntimeEvent({ direction: "out", to: target.toUserId, length: text.length, status: "token_expired", error: e }, process.stderr);
      botToken = "";
      process.exitCode = 1;
      process.exit();
    }
    throw e;
  }
}

async function sendWechatFile(target, filePath) {
  if (!botToken) {
    throw new Error("WeChat iLink bot is not logged in");
  }
  if (!target || !target.toUserId) {
    throw new Error("No WeChat target is available");
  }
  const result = await sendFileFromRuntime({
    path: filePath,
    botToken,
    toUserId: target.toUserId,
    contextToken: target.contextToken || "",
    runtimeDir: RUNTIME_DIR,
    ilinkClient
  });
  writeRuntimeEvent({ direction: "out", media: result.type, to: target.toUserId, length: result.size, status: "sent" });
  return result;
}

let inboundQueue;

const adapter = createWxBotAdapter({
  controlPlaneUrl,
  stateFile: WXBOT_STATE_FILE,
  logger: runtimeLogger,
  onTurnSettled: () => {
    if (!inboundQueue) return;
    inboundQueue.markSettled();
    if (!inboundQueue.busy) replyTarget = null;
  },
  sendText: async (text) => {
    await sendWechatText(replyTarget || currentTarget, text);
  },
  sendFile: async (filePath) => {
    return sendWechatFile(replyTarget || currentTarget, filePath);
  }
});

inboundQueue = new InboundMessageQueue({
  mergeWindowMs: Number(process.env.WXBOT_MERGE_WINDOW_MS || 0),
  textMergeWindowMs: Number(process.env.WXBOT_TEXT_MERGE_WINDOW_MS || process.env.WXBOT_MERGE_WINDOW_MS || 0),
  voiceMergeWindowMs: Number(process.env.WXBOT_VOICE_MERGE_WINDOW_MS || process.env.WXBOT_MERGE_WINDOW_MS || 0),
  mediaMergeWindowMs: Number(process.env.WXBOT_MEDIA_MERGE_WINDOW_MS || process.env.WXBOT_MERGE_WINDOW_MS || 0),
  settleDelayMs: Number(process.env.WXBOT_SETTLE_DELAY_MS || 0),
  pendingTtlMs: Number(process.env.WXBOT_PENDING_TTL_MS || 30 * 60 * 1000),
  sendToCodex: async (item) => {
    replyTarget = item.target;
    const result = await adapter.handleText(item.payload);
    if (result && result.sent === false && inboundQueue) {
      inboundQueue.markSettled();
    }
  },
  onDispatchError: (error, item) => {
    writeRuntimeEvent({
      direction: "queue",
      to: item.target && item.target.toUserId,
      status: "dispatch_failed",
      error
    }, process.stderr);
  }
});

setInterval(() => {
  reconcileQueue("timer").catch((error) => {
    writeRuntimeEvent({ direction: "queue", status: "reconcile_failed", error }, process.stderr);
  });
}, RECONCILE_INTERVAL_MS);

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

process.on("SIGINT", () => {
  stopping = true;
  process.stdout.write("\nStopping...\n");
});

async function main() {
  process.stdout.write("Codex WeChat iLink Adapter\n");

  while (!stopping) {
    if (!botToken) {
      try {
        botToken = await loginByQrcode();
      } catch (e) {
        process.stderr.write(`Login failed: ${e.message}\n`);
        await sleep(5000);
        continue;
      }
    } else {
      process.stdout.write("Using ILINK_BOT_TOKEN from environment.\n");
    }

    process.stdout.write("WeChat bound. Polling messages...\n");
    process.stdout.write("Send /help in WeChat to start.\n");

    let consecutiveErrors = 0;
    while (!stopping && botToken) {
      try {
        const result = await ilinkClient.getUpdates(botToken, getUpdatesBuf);
        const nextUpdatesBuf = result.sync_buf || result.get_updates_buf || getUpdatesBuf;

        const ret = result.ret;
        if (ret !== undefined && ret !== 0) {
          process.stderr.write(`getUpdates ret=${ret}\n`);
          if (ret === 401) {
            process.stderr.write("iLink token expired. Clearing token and restarting login...\n");
            botToken = "";
            try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* ignore */ }
            break; // Break inner loop to regenerate QR
          }
          consecutiveErrors++;
          if (consecutiveErrors > 5) {
            await sleep(5000);
          }
          continue;
        }

        consecutiveErrors = 0;

        for (const message of result.msgs || []) {
          const text = textFromIlinkMessage(message);
          const media = extractMediaItems(message);
          if (isDuplicateInboundMessage(message)) {
            writeRuntimeEvent({ direction: "in", from: message.from_user_id, length: text.length, status: "duplicate_skipped" });
            continue;
          }
          const target = {
            toUserId: message.from_user_id,
            contextToken: message.context_token || ""
          };
          currentTarget = target;
          saveLastTarget(target, RUNTIME_DIR);

          if (text) {
            writeRuntimeEvent({ direction: "in", from: message.from_user_id, length: text.length, status: "received" });
          }

          if (isDirectCommand(text) && media.length === 0) {
            const previousReplyTarget = replyTarget;
            replyTarget = target;
            try {
              await adapter.handleText(text);
              if (text === "/stop") inboundQueue.markSettled();
            } finally {
              replyTarget = previousReplyTarget;
            }
            continue;
          }

          await reconcileQueue("inbound", message.from_user_id);

          let mediaResult = { saved: [], errors: [] };
          if (media.length > 0) {
            writeRuntimeEvent({
              direction: "in",
              from: message.from_user_id,
              media: media.map((item) => item.type),
              count: media.length,
              status: "media_received"
            });
            mediaResult = await ilinkClient.downloadMediaItems(media, MEDIA_DIR);
            if (mediaResult.errors.length) {
              writeRuntimeEvent({
                direction: "in",
                from: message.from_user_id,
                status: "media_save_failed",
                error: mediaResult.errors.map((item) => errorSummary(item.error)).join(" | ")
              }, process.stderr);
            }
          }

          const queueResult = inboundQueue.receive({
            target,
            text,
            saved: mediaResult.saved,
            errors: mediaResult.errors
          });
          writeRuntimeEvent({ direction: "queue", from: message.from_user_id, status: queueResult.status, held: queueResult.held || 0, queued: inboundQueue.queue.length, busy: inboundQueue.busy });
        }
        if (nextUpdatesBuf !== getUpdatesBuf) {
          getUpdatesBuf = nextUpdatesBuf;
          saveUpdatesCursor(getUpdatesBuf);
        }
      } catch (error) {
        if (error && error.name === "TimeoutError") continue;
        process.stderr.write(`poll error: ${error.message || error}\n`);
        await sleep(3000);
      }
    }
  }
}

async function reconcileQueue(reason, fromUserId = "") {
  if (!inboundQueue || !inboundQueue.busy) return;
  if (inboundQueue.activeAgeMs() < RECONCILE_MIN_BUSY_MS) return;
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    const reconcile = await adapter.reconcileCurrentTurnState();
    if (reconcile.checked) {
      writeRuntimeEvent({ direction: "queue", from: fromUserId, status: "reconciled", reason, running: reconcile.running, turnStatus: reconcile.status || "" });
    }
  } finally {
    reconcileInFlight = false;
  }
}

async function loginByQrcode() {
  const qrcodeResponse = await ilinkClient.getBotQrcode();
  const qrcode = await writeQrcodeArtifact(qrcodeResponse);

  process.stdout.write("\nScan the WeChat login QR code.\n");
  if (qrcode.qrcodeUrl) {
    process.stdout.write(`QR URL: ${qrcode.qrcodeUrl}\n`);
    try {
      const qrcodeTerminal = require('qrcode-terminal');
      process.stdout.write('\n======================================\n');
      process.stdout.write('请使用微信扫描下方二维码登录 Bot：\n');
      qrcodeTerminal.generate(qrcode.qrcodeUrl, {small: true});
      process.stdout.write('======================================\n\n');
    } catch (err) {}
  }
  process.stdout.write("Waiting for confirmation...\n");

  for (let attempt = 0; attempt < 150; attempt += 1) {
    await sleep(2000);
    let status;
    try {
      status = normalizeLoginStatus(await ilinkClient.getQrcodeStatus(qrcode.qrcode));
    } catch (error) {
      if (error && error.name === "AbortError") {
        process.stdout.write("login status: timeout, continue waiting\n");
        continue;
      }
      throw error;
    }
    process.stdout.write(`login status: ${status.status}\n`);
    if (status.status === "confirmed" && status.botToken) {
      saveTokenToFile(status.botToken);
      return status.botToken;
    }
    if (status.status === "expired") {
      throw new Error("QR code expired. Restart and scan again.");
    }
  }

  throw new Error("QR login timed out.");
}

async function writeQrcodeArtifact(response) {
  const runtimeDir = RUNTIME_DIR;
  fs.mkdirSync(runtimeDir, { recursive: true });

  const rawPath = path.join(runtimeDir, "ilink-qrcode-response.json");
  fs.writeFileSync(rawPath, JSON.stringify(response, null, 2), "utf8");
  process.stdout.write(`QR raw response: ${rawPath}\n`);

  const qrcode = normalizeQrcodeResponse(response);
  if (!qrcode.qrcode) {
    process.stdout.write("WARNING: iLink response did not include qrcode field. See raw response above.\n");
  } else {
    const rawTextPath = path.join(runtimeDir, "ilink-qrcode-raw.txt");
    fs.writeFileSync(rawTextPath, qrcode.qrcode, "utf8");
    process.stdout.write(`QR raw text: ${rawTextPath}\n`);
  }

  if (qrcode.imageContent && !looksLikeUrl(qrcode.imageContent)) {
    const pngPath = path.join(runtimeDir, "ilink-qrcode.png");
    fs.writeFileSync(pngPath, Buffer.from(stripDataUrlPrefix(qrcode.imageContent), "base64"));
    process.stdout.write(`QR image: ${pngPath}\n`);
  }

  if (qrcode.qrcodeUrl) {
    const txtPath = path.join(runtimeDir, "ilink-qrcode-url.txt");
    fs.writeFileSync(txtPath, qrcode.qrcodeUrl, "utf8");
    process.stdout.write(`QR URL file: ${txtPath}\n`);
  }

  if (!qrcode.imageContent || looksLikeUrl(qrcode.imageContent)) {
    const qrText = qrcode.qrcodeUrl || qrcode.qrcode || qrcode.imageContent || "";
    if (qrText) {
      await tryWriteGeneratedQrcode(runtimeDir, qrText);
    }
  }

  return qrcode;
}

function looksLikeUrl(value) {
  return !value || String(value).startsWith("http") || String(value).length < 200;
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:image\/\w+;base64,/, "");
}

function normalizeQrcodeResponse(response) {
  const imageContent = response.qrcode_img_content ||
    response.qrcodeImgContent ||
    response.qrcode_img ||
    response.qrcodeImg ||
    "";
  const imageUrl = looksLikeUrl(imageContent) ? imageContent : "";
  return {
    qrcode: response.qrcode || response.qrCode || response.code || "",
    qrcodeUrl: response.qrcode_url || response.qrcodeUrl || response.qrCodeUrl || response.url || imageUrl || "",
    imageContent
  };
}

function normalizeLoginStatus(response) {
  return {
    status: response.status || response.state || "",
    botToken: response.bot_token || response.botToken || response.token || "",
    baseurl: response.baseurl || response.base_url || response.baseUrl || ""
  };
}

async function tryWriteGeneratedQrcode(runtimeDir, text) {
  const qrcodeModule = tryRequireQrcode();
  if (!qrcodeModule) {
    process.stdout.write("QR PNG generation skipped: qrcode package not found. Use QR raw text or URL file.\n");
    return;
  }

  const pngPath = path.join(runtimeDir, "ilink-qrcode.png");
  await qrcodeModule.toFile(pngPath, text, {
    type: "png",
    width: 320,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" }
  });
  process.stdout.write(`QR image: ${pngPath}\n`);
}

function tryRequireQrcode() {
  const candidates = [
    "qrcode",
    path.resolve(__dirname, "..", "node_modules", "qrcode"),
    path.resolve(__dirname, "..", "..", "..", "node_modules", "qrcode"),
    "F:\\cx\\cx\\1\\assistant\\node_modules\\qrcode"
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

function isDuplicateInboundMessage(message) {
  const id = message && (message.msg_id || message.message_id || message.msgId || message.id);
  if (!id) return false;
  const now = Date.now();
  for (const [key, timestamp] of processedInboundMessages) {
    if (now - timestamp > INBOUND_DEDUP_TTL_MS) processedInboundMessages.delete(key);
  }
  const key = `${message.from_user_id || ""}:${id}`;
  if (processedInboundMessages.has(key)) return true;
  processedInboundMessages.set(key, now);
  while (processedInboundMessages.size > INBOUND_DEDUP_MAX) {
    processedInboundMessages.delete(processedInboundMessages.keys().next().value);
  }
  return false;
}

function isDirectCommand(text) {
  return String(text || "").trim().startsWith("/");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

