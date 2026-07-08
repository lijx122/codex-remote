"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const WEIXIN_MEDIA_HOSTS = new Set([
  "novac2c.cdn.weixin.qq.com",
  "ilinkai.weixin.qq.com",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
  "res.wx.qq.com",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn"
]);

class ILinkClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || ILINK_BASE).replace(/\/$/, "");
    this.cdnBaseUrl = (options.cdnBaseUrl || process.env.WEIXIN_CDN_BASE_URL || WEIXIN_CDN_BASE).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs || 40000;
  }

  async getBotQrcode() {
    return this.request("/ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "GET",
      auth: false,
      timeoutMs: 30000
    });
  }

  async getQrcodeStatus(qrcode) {
    return this.request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      method: "GET",
      auth: false,
      timeoutMs: 30000
    });
  }

  async getUpdates(botToken, getUpdatesBuf = "") {
    const result = await this.request("/ilink/bot/getupdates", {
      method: "POST",
      botToken,
      timeoutMs: this.timeoutMs,
      body: {
        get_updates_buf: getUpdatesBuf || "",
        base_info: { channel_version: "1.0.2" }
      }
    });
    return result || { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
  }

  async sendTextMessage(botToken, toUserId, text, contextToken = "") {
    const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.request("/ilink/bot/sendmessage", {
      method: "POST",
      botToken,
      timeoutMs: 30000,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken || "",
          item_list: [
            { type: ITEM_TEXT, text_item: { text } }
          ]
        }
      }
    });
  }

  async downloadMediaItems(mediaItems, outputDir, options = {}) {
    return downloadMediaItems(mediaItems, outputDir, {
      cdnBaseUrl: this.cdnBaseUrl,
      ...options
    });
  }

  async request(requestPath, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${requestPath}`, {
        method: options.method || "GET",
        headers: buildHeaders(options.botToken),
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`iLink request failed: ${response.status} ${requestPath}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildHeaders(botToken) {
  const headers = {
    "content-type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": genWeixinUin()
  };
  if (botToken) {
    headers.Authorization = `Bearer ${botToken}`;
  }
  return headers;
}

function genWeixinUin() {
  const uint32 = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(uint32)).toString("base64");
}

function textFromIlinkMessage(message) {
  if (!message || message.message_type !== 1) return "";
  const block = (message.item_list || []).find((item) => item.type === ITEM_TEXT);
  if (block && block.text_item && block.text_item.text) return block.text_item.text;
  const voice = (message.item_list || []).find((item) => item.type === ITEM_VOICE);
  return voice && voice.voice_item && voice.voice_item.text ? voice.voice_item.text : "";
}

function extractMediaItems(message) {
  if (!message || !Array.isArray(message.item_list)) return [];
  const items = [];
  for (const item of message.item_list) {
    if (item.type === ITEM_IMAGE && (item.image_item || item.img_item)) {
      const imageItem = item.image_item || item.img_item || {};
      const media = getMediaReference(imageItem);
      items.push(normalizeMediaItem({
        type: "image",
        desc: "[image]",
        extension: ".jpg",
        encryptedQueryParam: media.encrypt_query_param,
        fullUrl: media.full_url || imageItem.cdnurl,
        aesKey: imageItem.aeskey || media.aes_key || imageItem.aes_key
      }));
    } else if (item.type === ITEM_VOICE && item.voice_item) {
      const voiceItem = item.voice_item || {};
      const media = getMediaReference(voiceItem);
      items.push(normalizeMediaItem({
        type: "voice",
        desc: "[voice]",
        extension: ".silk",
        encryptedQueryParam: media.encrypt_query_param,
        fullUrl: media.full_url || voiceItem.cdnurl,
        aesKey: media.aes_key || voiceItem.aes_key,
        transcript: voiceItem.text || ""
      }));
    } else if (item.type === ITEM_FILE && item.file_item) {
      const fileItem = item.file_item || {};
      const media = getMediaReference(fileItem);
      items.push(normalizeMediaItem({
        type: "file",
        desc: `[file: ${fileItem.file_name || "unknown"}]`,
        fileName: fileItem.file_name || "document.bin",
        encryptedQueryParam: media.encrypt_query_param,
        fullUrl: media.full_url || fileItem.cdnurl,
        aesKey: media.aes_key || fileItem.aes_key
      }));
    } else if (item.type === ITEM_VIDEO && item.video_item) {
      const videoItem = item.video_item || {};
      const media = getMediaReference(videoItem);
      items.push(normalizeMediaItem({
        type: "video",
        desc: "[video]",
        extension: ".mp4",
        encryptedQueryParam: media.encrypt_query_param,
        fullUrl: media.full_url || videoItem.cdnurl,
        aesKey: media.aes_key || videoItem.aes_key
      }));
    }
  }
  return items;
}

function getMediaReference(item) {
  return item && item.media ? item.media : {};
}

function normalizeMediaItem(item) {
  return {
    ...item,
    encryptedQueryParam: item.encryptedQueryParam || "",
    fullUrl: item.fullUrl || "",
    aesKey: item.aesKey || "",
    fileName: item.fileName || "",
    extension: item.extension || extensionFromFileName(item.fileName) || ".bin"
  };
}

async function downloadMediaItems(mediaItems, outputDir, options = {}) {
  const saved = [];
  const errors = [];
  await fs.promises.mkdir(outputDir, { recursive: true });
  for (const item of mediaItems || []) {
    try {
      const data = await downloadAndDecryptMedia(item, options);
      const filePath = await writeMediaFile(outputDir, item, data);
      saved.push({ ...item, path: filePath, size: data.length });
    } catch (error) {
      errors.push({ ...item, error: error.message || String(error) });
    }
  }
  return { saved, errors };
}

async function downloadAndDecryptMedia(item, options = {}) {
  const url = mediaDownloadUrl(item, options.cdnBaseUrl || WEIXIN_CDN_BASE);
  assertWeixinMediaUrl(url, options);
  const raw = await downloadBytes(url, options);
  return item.aesKey ? aes128EcbDecrypt(raw, parseAesKey(item.aesKey)) : raw;
}

function mediaDownloadUrl(item, cdnBaseUrl) {
  if (item.encryptedQueryParam) {
    return `${cdnBaseUrl.replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(item.encryptedQueryParam)}`;
  }
  if (item.fullUrl) return item.fullUrl;
  throw new Error("media item has no encrypted query param or full url");
}

function assertWeixinMediaUrl(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`blocked non-https media url: ${url}`);
  const allowedHosts = new Set(WEIXIN_MEDIA_HOSTS);
  if (options.cdnBaseUrl) allowedHosts.add(new URL(options.cdnBaseUrl).hostname);
  for (const host of options.allowedHosts || []) allowedHosts.add(host);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`blocked media url host: ${parsed.hostname}`);
  }
}

async function downloadBytes(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl = options.fetch || fetch;
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) throw new Error(`media download failed: ${response.status} ${url}`);
    const length = Number(response.headers && response.headers.get && response.headers.get("content-length"));
    const maxBytes = options.maxBytes || DEFAULT_MAX_MEDIA_BYTES;
    if (length && length > maxBytes) throw new Error(`media too large: ${length} bytes`);
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    if (data.length > maxBytes) throw new Error(`media too large: ${data.length} bytes`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseAesKey(aesKey) {
  const text = String(aesKey || "").trim();
  if (!text) throw new Error("empty aes key");
  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 16) return decoded;
  const decodedText = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }
  throw new Error(`unexpected aes key format (${decoded.length} decoded bytes)`);
}

function aes128EcbDecrypt(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (!decrypted.length) return decrypted;
  const padding = decrypted[decrypted.length - 1];
  if (padding > 0 && padding <= 16) {
    let valid = true;
    for (let index = decrypted.length - padding; index < decrypted.length; index += 1) {
      if (decrypted[index] !== padding) {
        valid = false;
        break;
      }
    }
    if (valid) return decrypted.subarray(0, decrypted.length - padding);
  }
  return decrypted;
}

async function writeMediaFile(outputDir, item, data) {
  const safeBase = safeFileBase(item.fileName || `${item.type || "media"}${item.extension || ".bin"}`);
  const ext = extensionFromFileName(safeBase) || item.extension || ".bin";
  const stem = path.basename(safeBase, ext) || item.type || "media";
  const dateDir = path.join(outputDir, new Date().toISOString().slice(0, 10));
  await fs.promises.mkdir(dateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const target = await uniquePath(dateDir, `${stamp}-${stem}${ext}`);
  await fs.promises.writeFile(target, data);
  return path.resolve(target);
}

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(dir, index === 0 ? filename : `${stem}-${index}${ext}`);
    try {
      await fs.promises.access(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`could not allocate media filename for ${filename}`);
}

function safeFileBase(filename) {
  const fallback = "media.bin";
  const base = path.basename(String(filename || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base || fallback;
}

function extensionFromFileName(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return ext && ext.length <= 10 ? ext : "";
}

module.exports = {
  ILinkClient,
  textFromIlinkMessage,
  extractMediaItems,
  downloadMediaItems,
  parseAesKey,
  aes128EcbDecrypt
};
