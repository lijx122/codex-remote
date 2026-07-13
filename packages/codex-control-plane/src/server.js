"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { createCodexFollower } = require("../../codex-follower-core/src");
const { sendFileFromRuntime } = require("../../../adapters/wxbot/src/sendfile-service");

const EVENT_TYPES = new Set([
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
]);

const WEB_ADAPTER_DIR = path.resolve(__dirname, "..", "..", "..", "adapters", "web");
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function createControlPlaneServer(options = {}) {
  const core = options.core || createCodexFollower(options.coreOptions || {});
  const sendFile = options.sendFile || sendFileFromRuntime;
  const clients = new Set();
  let connected = false;
  let connecting = null;

  if (core.transport && typeof core.transport.on === "function") {
    core.transport.on("connect", () => {
      connected = true;
    });
    core.transport.on("close", () => {
      connected = false;
    });
  }

  function logCommand(name, detail) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      layer: "control-plane",
      command: name,
      ...detail
    }));
  }

  async function ensureConnected() {
    if (connected && core.connected) return;
    if (!connecting) {
      connecting = core.connect()
        .then(async () => {
          // Wait 500ms for Desktop to broadcast currently loaded threads
          await new Promise((r) => setTimeout(r, 500));
          connected = true;
        })
        .finally(() => {
          connecting = null;
        });
    }
    await connecting;
  }

  async function sendJson(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(json)
    });
    res.end(json);
  }

  async function sendStatic(res, pathname) {
    const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = path.resolve(WEB_ADAPTER_DIR, relativePath);
    if (!filePath.startsWith(WEB_ADAPTER_DIR + path.sep)) {
      await sendJson(res, 404, { error: "not found" });
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        "content-type": STATIC_TYPES[path.extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store",
        "content-length": body.length
      });
      res.end(body);
    } catch (error) {
      await sendJson(res, 404, { error: "not found" });
    }
  }

  async function sendMessageWithWarmRetry(conversationId, message) {
    const maxAttempts = 4;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await core.sendMessage(conversationId, message);
        logCommand(attempt === 1 ? "send.result" : "send.retry.result", {
          conversationId,
          ok: result.ok,
          attempt
        });
        return result;
      } catch (error) {
        lastError = error;
        const errMsg = String(error.message || "");
        logCommand(attempt === 1 ? "send.error" : "send.retry.error", {
          conversationId,
          error: errMsg,
          attempt
        });
        if (!/no-client-found|not found/i.test(errMsg) || attempt === maxAttempts) break;
        logCommand("warm.before-retry", { conversationId, attempt });
        const warmResult = await core.warmThread(conversationId);
        logCommand("warm.before-retry.result", { conversationId, attempt, ...warmResult });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw lastError;
  }

  async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  function normalizeError(error) {
    return {
      type: "error",
      message: error && error.message ? error.message : String(error),
      response: error && error.response ? error.response : undefined
    };
  }

  function toWireEvent(event) {
    return {
      type: EVENT_TYPES.has(event.type) ? event.type : "error",
      conversationId: event.conversationId || null,
      payload: { ...event, type: undefined, conversationId: undefined }
    };
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (req.method === "OPTIONS") {
        await sendJson(res, 204, {});
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        await sendJson(res, 200, { ok: true, connected });
        return;
      }

      if (req.method === "GET" && url.pathname === "/sendfile") {
        await sendJson(res, 200, {
          ok: true,
          usage: "POST /sendfile with JSON body {\"path\":\"C:\\\\path\\\\file.png\"}",
          powershell: "Invoke-RestMethod -Uri http://127.0.0.1:8787/sendfile -Method Post -ContentType 'application/json' -Body (@{ path = 'C:\\path\\file.png' } | ConvertTo-Json)"
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/threads") {
        await ensureConnected();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await sendJson(res, 200, core.listThreads().map((thread) => ({
          conversationId: thread.id,
          title: thread.title || thread.id,
          updatedAt: thread.updatedAt || null,
          cwd: thread.cwd || null,
          runtimeStatus: thread.runtimeStatus || null,
          sendable: thread.sendable || false
        })));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/history/")) {
        await ensureConnected();
        const conversationId = decodeURIComponent(url.pathname.slice("/history/".length));
        const result = await core.loadHistory(conversationId);
        await sendJson(res, 200, {
          conversationId,
          revision: result.revision,
          state: result.state
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/send") {
        await ensureConnected();
        const body = await readJson(req);
        logCommand("send", {
          conversationId: body.conversationId,
          messageLength: typeof body.message === "string" ? body.message.length : 0
        });
        try {
          const result = await sendMessageWithWarmRetry(body.conversationId, body.message);
          await sendJson(res, 200, { ok: true, raw: result.raw });
        } catch (error) {
          const errMsg = String(error.message || "");
          await sendJson(res, 409, {
            ok: false,
            error: "会话自动打开后仍不可发送，请稍后重试",
            detail: errMsg
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/sendfile") {
        const body = await readJson(req);
        logCommand("sendfile", {
          path: body.path || body.filePath || "",
          hasTarget: Boolean(body.toUserId || body.to)
        });
        try {
          const result = await sendFile({
            path: body.path || body.filePath,
            caption: body.caption || "",
            toUserId: body.toUserId || body.to || "",
            contextToken: body.contextToken || ""
          });
          logCommand("sendfile.result", {
            ok: true,
            path: result.path,
            type: result.type,
            size: result.size
          });
          await sendJson(res, 200, result);
        } catch (error) {
          await sendJson(res, 409, {
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/interrupt") {
        await ensureConnected();
        const body = await readJson(req);
        logCommand("interrupt", { conversationId: body.conversationId });
        const result = await core.interrupt(body.conversationId);
        logCommand("interrupt.result", { conversationId: body.conversationId, ok: result.ok });
        await sendJson(res, 200, { ok: result.ok });
        return;
      }

      if (req.method === "POST" && url.pathname === "/warm") {
        await ensureConnected();
        const body = await readJson(req);
        logCommand("warm", { conversationId: body.conversationId });
        const result = await core.warmThread(body.conversationId);
        logCommand("warm.result", { conversationId: body.conversationId, ...result });
        await sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/approve") {
        await ensureConnected();
        const body = await readJson(req);
        const decision = body.decision === true || body.decision === "allow" ? "allow" : "deny";
        logCommand("approve", {
          conversationId: body.conversationId,
          approvalId: body.approvalId,
          decision
        });
        const result = await core.approve(body.conversationId, body.approvalId, decision);
        logCommand("approve.result", { conversationId: body.conversationId, ok: result.ok });
        await sendJson(res, 200, { ok: result.ok });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/wx/status") {
        const runtimeDir = process.env.CODEX_REMOTE_RUNTIME_DIR || path.resolve(__dirname, "..", "..", "..", "adapters", "wxbot", ".runtime");
        const qrcodeUrlPath = path.join(runtimeDir, "ilink-qrcode-url.txt");
        const tokenPath = path.join(runtimeDir, "ilink-bot-token.json");
        
        try {
          const hasToken = await fs.access(tokenPath).then(() => true).catch(() => false);
          if (hasToken) {
            await sendJson(res, 200, { status: "logged_in" });
          } else {
            const qrcodeUrl = await fs.readFile(qrcodeUrlPath, "utf8").catch(() => "");
            await sendJson(res, 200, { status: "waiting", qrcodeUrl: qrcodeUrl });
          }
        } catch (err) {
          await sendJson(res, 200, { status: "waiting", qrcodeUrl: "" });
        }
        return;
      }

      if (req.method === "GET") {
        await sendStatic(res, url.pathname);
        return;
      }

      await sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        layer: "control-plane",
        error: error && error.message ? error.message : String(error)
      }));
      await sendJson(res, 500, normalizeError(error));
    }
  }

  const server = http.createServer(handleRequest);

  server.on("upgrade", async (req, socket) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/events") {
      socket.destroy();
      return;
    }

    const conversationId = url.searchParams.get("conversationId");
    if (!conversationId) {
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    const client = createWebSocketClient(socket, conversationId);
    clients.add(client);
    client.subscription = core.subscribeEvents(conversationId);
    client.subscription.on("*", (event) => client.send(toWireEvent(event)));
    client.send({ type: "connected", conversationId: client.conversationId || null, payload: {} });

    socket.on("close", () => {
      if (client.subscription && client.subscription.unsubscribe) {
        client.subscription.unsubscribe();
      }
      clients.delete(client);
    });
    socket.on("error", () => {
      if (client.subscription && client.subscription.unsubscribe) {
        client.subscription.unsubscribe();
      }
      clients.delete(client);
    });

    try {
      await ensureConnected();
      await core.loadHistory(client.conversationId);
    } catch (error) {
      client.send({ type: "error", conversationId: client.conversationId || null, payload: normalizeError(error) });
    }
  });

  return {
    server,
    core,
    listen(port, host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      core.disconnect();
      for (const client of clients) {
        client.close();
      }
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function createWebSocketClient(socket, conversationId) {
  return {
    conversationId,
    send(value) {
      if (socket.destroyed) return;
      socket.write(encodeWebSocketFrame(JSON.stringify(value)));
    },
    close() {
      if (!socket.destroyed) {
        socket.end();
      }
    }
  };
}

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header = [];
  header.push(0x81);

  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push(
      (payload.length >> 24) & 0xff,
      (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff
    );
  }

  return Buffer.concat([Buffer.from(header), payload]);
}

module.exports = { createControlPlaneServer };
