"use strict";

class ControlPlaneClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs || 15000;
  }

  async listThreads() {
    return this.request("/threads");
  }

  async loadHistory(conversationId) {
    return this.request(`/threads/${encodeURIComponent(conversationId)}`);
  }

  async send(conversationId, message) {
    return this.request(`/threads/${encodeURIComponent(conversationId)}/message`, {
      method: "POST",
      body: { text: message }
    });
  }

  async interrupt(conversationId) {
    return this.request(`/threads/${encodeURIComponent(conversationId)}/stop`, {
      method: "POST",
      body: {}
    });
  }

  async approve(conversationId, approvalId, decision) {
    return this.request(`/approval/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: { decision }
    });
  }

  connectEvents(conversationId, handlers = {}) {
    const wsUrl = `${this.baseUrl}/threads/${encodeURIComponent(conversationId)}/events`;

    // Instead of WebSocket (which daily_server doesn't support), we use EventSource (SSE)
    // Wait, Node.js doesn't have EventSource built-in.
    // Let's implement a simple fetch-based SSE reader for the daily_server

    let active = true;
    const controller = new AbortController();

    const start = async () => {
      if (handlers.open) handlers.open();
      try {
        const response = await fetch(wsUrl, {
          method: "GET",
          headers: {
            "Accept": "text/event-stream"
          },
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`SSE connect failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (active) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n\r?\n/);
          buffer = lines.pop() || "";

          for (const chunk of lines) {
            if (!chunk.trim()) continue;
            if (chunk.startsWith("data: ")) {
              try {
                const data = JSON.parse(chunk.slice(6));
                if (handlers.message) handlers.message({
                   type: extractTypeFromSse(data),
                   conversationId: data.params?.threadId || conversationId,
                   payload: data
                });
              } catch (e) {
                // ignore parse error
              }
            }
          }
        }
      } catch (error) {
        if (active && handlers.error) handlers.error(error);
      } finally {
        if (active && handlers.close) handlers.close();
      }
    };

    start();

    return {
      close() {
        active = false;
        controller.abort();
      }
    };
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

function extractTypeFromSse(data) {
  const method = data.method || "";
  if (method === "thread-stream-state-changed") return "thread_state_changed";
  if (method === "turn/completed") return "turn_completed";
  if (method === "commandExecution/requestApproval" || method === "item/commandExecution/requestApproval" || method.includes("requestApproval")) return "approval_request";
  if (method === "agent/message/delta" || method === "item/started" || method === "item/completed") return "message";
  return method;
}

function isConnectionError(error) {
  const message = error && error.message ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/i.test(message);
}

module.exports = { ControlPlaneClient };
