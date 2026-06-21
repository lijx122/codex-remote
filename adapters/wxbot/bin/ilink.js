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
const { ILinkClient, textFromIlinkMessage, extractMediaItems } = require("../src/ilink-client");

const ilinkClient = new ILinkClient();
const controlPlaneUrl = process.env.CODEX_CONTROL_PLANE_URL || "http://127.0.0.1:8787";

const RUNTIME_DIR = path.resolve(__dirname, "..", ".runtime");
const TOKEN_FILE = path.join(RUNTIME_DIR, "ilink-bot-token.json");

let botToken = process.env.ILINK_BOT_TOKEN || loadTokenFromFile();
let getUpdatesBuf = "";
let currentTarget = null;
let stopping = false;

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

function saveTokenToFile(token) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ bot_token: token, saved_at: new Date().toISOString() }, null, 2), "utf8");
    process.stdout.write(`Saved bot_token to ${TOKEN_FILE}\n`);
  } catch (e) {
    process.stderr.write(`Failed to save token: ${e.message}\n`);
  }
}

const adapter = createWxBotAdapter({
  controlPlaneUrl,
  sendText: async (text) => {
    if (!botToken) {
      process.stdout.write(`[WX OUT skipped: not logged in]\n${text}\n`);
      return;
    }
    if (!currentTarget || !currentTarget.toUserId) {
      process.stdout.write(`[WX OUT skipped: no target]\n${text}\n`);
      return;
    }

    // Wrap the sendTextMessage in a try-catch to auto-recover if it's a 401 error
    try {
      await ilinkClient.sendTextMessage(botToken, currentTarget.toUserId, text, currentTarget.contextToken || "");
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), direction: "out", to: shortId(currentTarget.toUserId), length: text.length })}\n`);
    } catch (e) {
      if (String(e.message).includes("401")) {
        process.stdout.write(`[WX OUT error] Token expired (401) during send. Clearing token.\n`);
        botToken = "";
        process.exitCode = 1;
        process.exit();
      }
      throw e;
    }
  }
});

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
        if (result.get_updates_buf) getUpdatesBuf = result.get_updates_buf;
        if (result.sync_buf) getUpdatesBuf = result.sync_buf;

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
          currentTarget = {
            toUserId: message.from_user_id,
            contextToken: message.context_token || ""
          };

          if (text) {
            process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), direction: "in", from: shortId(message.from_user_id), text })}\n`);
            await adapter.handleText(text);
          } else if (media.length > 0) {
            const desc = media.map(m => m.desc).join(", ");
            process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), direction: "in", from: shortId(message.from_user_id), media: desc })}\n`);
            // Forward media as text description to Desktop
            const label = `[收到 ${desc}]`;
            await adapter.handleText(label);
          }
        }
      } catch (error) {
        if (error && error.name === "TimeoutError") continue;
        process.stderr.write(`poll error: ${error.message || error}\n`);
        await sleep(3000);
      }
    }
  }
}

async function loginByQrcode() {
  const qrcodeResponse = await ilinkClient.getBotQrcode();
  const qrcode = await writeQrcodeArtifact(qrcodeResponse);

  process.stdout.write("\nScan the WeChat login QR code.\n");
  if (qrcode.qrcodeUrl) {
    process.stdout.write(`QR URL: ${qrcode.qrcodeUrl}\n`);
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
  const runtimeDir = path.resolve(__dirname, "..", ".runtime");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
