"use strict";

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

const INITIAL_CLIENT_ID = "initializing-client";
const DEFAULT_CLIENT_TYPE = "codex-follower-core";
const DEFAULT_TIMEOUT_MS = 12000;

const METHOD_VERSIONS = {
  "thread-stream-state-changed": 7,
  "thread-read-state-changed": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 2,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1
};

function defaultPipePath() {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\codex-ipc";
  }
  return path.join(os.tmpdir(), "codex-ipc", "ipc.sock");
}

function encodeFrame(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(buffer, onMessage) {
  let pending = buffer;
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (length === 0 || length > 256 * 1024 * 1024) {
      throw new Error(`invalid IPC frame length: ${length}`);
    }
    if (pending.length < 4 + length) break;
    const body = pending.subarray(4, 4 + length);
    pending = pending.subarray(4 + length);
    onMessage(JSON.parse(body.toString("utf8")));
  }
  return pending;
}

class IpcTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipePath = options.pipePath || defaultPipePath();
    this.clientType = options.clientType || DEFAULT_CLIENT_TYPE;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.clientId = INITIAL_CLIENT_ID;
    this.socket = null;
    this.pendingBuffer = Buffer.alloc(0);
    this.pendingRequests = new Map();
  }

  async connect() {
    if (this.socket) {
      return { clientId: this.clientId };
    }

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;

      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = null;
        this.rejectPending(new Error("codex IPC connection closed"));
        this.emit("close");
      });
      socket.on("error", (error) => this.emit("error", error));
    });

    const response = await this.request("initialize", {
      clientType: this.clientType
    }, { sourceClientId: INITIAL_CLIENT_ID, version: 0 });

    if (!response.result || typeof response.result.clientId !== "string") {
      throw new Error("initialize response did not include clientId");
    }
    this.clientId = response.result.clientId;
    return { clientId: this.clientId };
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
    }
  }

  async request(method, params = {}, options = {}) {
    if (!this.socket) {
      throw new Error("codex IPC is not connected");
    }

    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: options.sourceClientId || this.clientId,
      version: options.version ?? METHOD_VERSIONS[method] ?? 0,
      method,
      params
    };

    if (options.targetClientId) {
      message.targetClientId = options.targetClientId;
    }

    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`IPC request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { method, resolve, reject, timer });
    });

    this.socket.write(encodeFrame(message));
    this.emit("send", message);
    return promise;
  }

  handleData(chunk) {
    try {
      this.pendingBuffer = decodeFrames(
        Buffer.concat([this.pendingBuffer, chunk]),
        (message) => this.handleMessage(message)
      );
    } catch (error) {
      this.emit("error", error);
    }
  }

  handleMessage(message) {
    this.emit("message", message);

    if (message.type === "client-discovery-request") {
      this.respondToDiscovery(message);
      return;
    }

    if (message.type === "response") {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.requestId);
      if (message.resultType === "success") {
        pending.resolve(message);
      } else {
        const error = new Error(message.error || `IPC request failed: ${pending.method}`);
        error.response = message;
        pending.reject(error);
      }
      return;
    }

    if (message.type === "broadcast") {
      this.emit("broadcast", message);
    }
  }

  respondToDiscovery(message) {
    const response = {
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false }
    };
    if (this.socket) {
      this.socket.write(encodeFrame(response));
      this.emit("send", response);
    }
  }

  respondToServer(requestId, result) {
    if (!this.socket) {
      throw new Error("codex IPC is not connected");
    }
    const response = {
      type: "response",
      requestId,
      resultType: "success",
      result
    };
    this.socket.write(encodeFrame(response));
    this.emit("send", response);
  }

  rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

module.exports = { IpcTransport, METHOD_VERSIONS, defaultPipePath };
