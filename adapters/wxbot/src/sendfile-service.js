"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { ILinkClient, mediaKindFromFileName } = require("./ilink-client");

function runtimeDir() {
  return process.env.CODEX_REMOTE_RUNTIME_DIR || path.resolve(__dirname, "..", ".runtime");
}

function tokenFilePath(baseDir = runtimeDir()) {
  return path.join(baseDir, "ilink-bot-token.json");
}

function lastTargetPath(baseDir = runtimeDir()) {
  return path.join(baseDir, "ilink-last-target.json");
}

function normalizeLocalFilePath(input) {
  let value = String(input || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("file:///")) {
    value = decodeURIComponent(value.slice("file:///".length));
  }
  return path.resolve(value);
}

async function assertReadableFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  return stat;
}

function loadBotToken(baseDir = runtimeDir()) {
  const envToken = process.env.ILINK_BOT_TOKEN || "";
  if (envToken) return envToken;
  try {
    const data = JSON.parse(fs.readFileSync(tokenFilePath(baseDir), "utf8"));
    return data.bot_token || "";
  } catch {
    return "";
  }
}

function loadLastTarget(baseDir = runtimeDir()) {
  try {
    const data = JSON.parse(fs.readFileSync(lastTargetPath(baseDir), "utf8"));
    return {
      toUserId: data.toUserId || "",
      contextToken: data.contextToken || ""
    };
  } catch {
    return { toUserId: "", contextToken: "" };
  }
}

function saveLastTarget(target, baseDir = runtimeDir()) {
  if (!target || !target.toUserId) return;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(lastTargetPath(baseDir), JSON.stringify({
    toUserId: target.toUserId,
    contextToken: target.contextToken || "",
    savedAt: new Date().toISOString()
  }, null, 2), "utf8");
}

async function sendFileFromRuntime(options = {}) {
  const baseDir = options.runtimeDir || runtimeDir();
  const filePath = normalizeLocalFilePath(options.path || options.filePath);
  const stat = await assertReadableFile(filePath);
  const token = options.botToken || loadBotToken(baseDir);
  if (!token) throw new Error("WeChat iLink bot token is not available");

  const target = options.toUserId
    ? { toUserId: options.toUserId, contextToken: options.contextToken || "" }
    : loadLastTarget(baseDir);
  if (!target.toUserId) {
    throw new Error("No WeChat target is available. Send any message from WeChat first.");
  }

  const client = options.ilinkClient || new ILinkClient(options.ilinkOptions || {});
  await client.sendLocalFileMessage(token, target.toUserId, filePath, target.contextToken || "", {
    caption: options.caption || ""
  });
  return {
    ok: true,
    path: filePath,
    fileName: path.basename(filePath),
    size: stat.size,
    type: mediaKindFromFileName(filePath),
    toUserId: target.toUserId
  };
}

module.exports = {
  assertReadableFile,
  lastTargetPath,
  loadBotToken,
  loadLastTarget,
  normalizeLocalFilePath,
  runtimeDir,
  saveLastTarget,
  sendFileFromRuntime,
  tokenFilePath
};
