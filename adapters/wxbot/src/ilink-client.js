"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ILINK_BASE = process.env.ILINK_BASE_URL || "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const UPLOAD_IMAGE = 1;
const UPLOAD_VIDEO = 2;
const UPLOAD_FILE = 3;
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
    this.fetch = options.fetch || fetch;
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
        base_info: buildBaseInfo()
      }
    });
    return result || { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
  }

  async sendTextMessage(botToken, toUserId, text, contextToken = "") {
    const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.request("/ilink/bot/sendmessage", {
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
    assertIlinkOk(result, "sendmessage");
    return result;
  }

  async sendLocalFileMessage(botToken, toUserId, filePath, contextToken = "", options = {}) {
    const uploaded = await this.uploadLocalMedia(botToken, toUserId, filePath, options);
    const caption = String(options.caption || "").trim();
    if (caption) {
      await this.sendTextMessage(botToken, toUserId, caption, contextToken);
    }
    const item = buildUploadedMediaItem(uploaded);
    const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.request("/ilink/bot/sendmessage", {
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
          item_list: [item]
        }
      }
    });
    assertIlinkOk(result, "sendmessage");
    return result;
  }

  async uploadLocalMedia(botToken, toUserId, filePath, options = {}) {
    const data = await fs.promises.readFile(filePath);
    const maxBytes = options.maxBytes || DEFAULT_MAX_MEDIA_BYTES;
    if (data.length > maxBytes) throw new Error(`file too large: ${data.length} bytes`);

    const fileName = path.basename(filePath);
    const mediaKind = mediaKindFromFileName(fileName);
    const mediaType = mediaKind === "image" ? UPLOAD_IMAGE : mediaKind === "video" ? UPLOAD_VIDEO : UPLOAD_FILE;
    const aesKey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString("hex");
    const rawfilemd5 = crypto.createHash("md5").update(data).digest("hex");
    const filesize = aes128EcbPaddedSize(data.length);
    const uploadUrlResp = await this.request("/ilink/bot/getuploadurl", {
      method: "POST",
      botToken,
      timeoutMs: 30000,
      body: {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: data.length,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex")
      }
    });
    assertIlinkOk(uploadUrlResp, "getuploadurl");
    const uploadParam = uploadUrlResp && uploadUrlResp.upload_param;
    const uploadFullUrl = uploadUrlResp && uploadUrlResp.upload_full_url;
    if (!uploadParam && !uploadFullUrl) {
      throw new Error(`getuploadurl returned no upload url: ${JSON.stringify(uploadUrlResp)}`);
    }
    const downloadEncryptedQueryParam = await this.uploadEncryptedBufferToCdn({
      data,
      uploadParam,
      uploadFullUrl,
      filekey,
      aesKey
    });
    return {
      type: mediaKind,
      fileName,
      fileSize: data.length,
      fileSizeCiphertext: filesize,
      downloadEncryptedQueryParam,
      aesKey
    };
  }

  async uploadEncryptedBufferToCdn({ data, uploadParam, uploadFullUrl, filekey, aesKey }) {
    const ciphertext = aes128EcbEncrypt(data, aesKey);
    const url = uploadFullUrl || `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: ciphertext
        });
        const errorText = response.headers && response.headers.get
          ? response.headers.get("x-error-message")
          : "";
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`CDN upload client error ${response.status}: ${errorText || await response.text()}`);
        }
        if (response.status !== 200) {
          throw new Error(`CDN upload server error: ${errorText || response.status}`);
        }
        const downloadParam = response.headers && response.headers.get
          ? response.headers.get("x-encrypted-param")
          : "";
        if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param header");
        return downloadParam;
      } catch (error) {
        lastError = error;
        if (String(error.message || "").includes("client error")) throw error;
        if (attempt === 3) break;
      }
    }
    throw lastError || new Error("CDN upload failed");
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
      const response = await this.fetch(`${this.baseUrl}${requestPath}`, {
        method: options.method || "GET",
        headers: buildHeaders(options.botToken),
        body: options.body ? JSON.stringify(withBaseInfo(options.body)) : undefined,
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

function buildUploadedMediaItem(uploaded) {
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aesKey.toString("hex"), "ascii").toString("base64"),
    encrypt_type: 1
  };
  if (uploaded.type === "image") {
    return {
      type: ITEM_IMAGE,
      image_item: {
        media,
        mid_size: uploaded.fileSizeCiphertext
      }
    };
  }
  if (uploaded.type === "video") {
    return {
      type: ITEM_VIDEO,
      video_item: {
        media,
        video_size: uploaded.fileSizeCiphertext
      }
    };
  }
  return {
    type: ITEM_FILE,
    file_item: {
      media,
      file_name: uploaded.fileName,
      len: String(uploaded.fileSize)
    }
  };
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function withBaseInfo(body) {
  if (!body || typeof body !== "object" || body.base_info) return body;
  return { ...body, base_info: buildBaseInfo() };
}

function assertIlinkOk(result, endpoint) {
  if (!result || typeof result !== "object") return;
  const ret = result.ret;
  const errcode = result.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = result.errmsg || result.msg || "unknown error";
    throw new Error(`iLink ${endpoint} error: ret=${ret} errcode=${errcode} errmsg=${errmsg}`);
  }
}

function buildHeaders(botToken) {
  const headers = {
    "content-type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": genWeixinUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION)
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

function mediaKindFromFileName(fileName) {
  const ext = extensionFromFileName(fileName);
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  return "file";
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
  if (process.env.ILINK_ALLOW_INSECURE_MEDIA === "1" && parsed.protocol === "http:") return;
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

function aes128EcbEncrypt(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aes128EcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
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
  mediaKindFromFileName,
  parseAesKey,
  aes128EcbDecrypt
};
