"use strict";

let WebSocketImpl;
try {
  WebSocketImpl = require("ws");
} catch {
  // Browser fallback
}

class ControlPlaneClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs || 15000;
  }

  async listThreads() {
    return this.request("/threads");
  }

  async loadHistory(conversationId) {
    return this.request(`/history/${encodeURIComponent(conversationId)}`);
  }

  async send(conversationId, message) {
    return this.request("/send", {
      method: "POST",
      body: { conversationId, message }
    });
  }

  async interrupt(conversationId) {
    return this.request("/interrupt", {
      method: "POST",
      body: { conversationId }
    });
  }

  async warm(conversationId) {
    return this.request("/warm", {
      method: "POST",
      body: { conversationId }
    });
  }

  async approve(conversationId, approvalId, decision) {
    return this.request("/approve", {
      method: "POST",
      body: { conversationId, approvalId, decision }
    });
  }

  connectEvents(conversationId, handlers = {}) {
    const WS = WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
    if (!WS) {
      throw new Error("WebSocket not available — install 'ws' for Node.js");
    }
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/events?conversationId=${encodeURIComponent(conversationId)}`;
    const socket = new WS(wsUrl);
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (handlers.message) handlers.message(data);
      } catch (error) {
        if (handlers.error) handlers.error(error);
      }
    });
    socket.addEventListener("error", (event) => {
      if (handlers.error) handlers.error(event.error || new Error("WebSocket error"));
    });
    socket.addEventListener("close", () => {
      if (handlers.close) handlers.close();
    });
    socket.addEventListener("open", () => {
      if (handlers.open) handlers.open();
    });
    return socket;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers: { "content-type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data.message || data.error || (data.response && data.response.error) || `HTTP ${response.status}`;
        throw new Error(String(message));
      }
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Desktop 当前离线");
      }
      if (isConnectionError(error)) {
        throw new Error("Desktop 当前离线");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isConnectionError(error) {
  const message = error && error.message ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/i.test(message);
}

module.exports = { ControlPlaneClient };
