"use strict";

const ILINK_BASE = "https://ilinkai.weixin.qq.com";

class ILinkClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || ILINK_BASE).replace(/\/$/, "");
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
            { type: 1, text_item: { text } }
          ]
        }
      }
    });
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers: buildHeaders(options.botToken),
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`iLink request failed: ${response.status} ${path}`);
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
  const block = (message.item_list || []).find((item) => item.type === 1);
  return block && block.text_item && block.text_item.text ? block.text_item.text : "";
}

module.exports = {
  ILinkClient,
  textFromIlinkMessage
};
