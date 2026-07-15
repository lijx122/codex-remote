"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const DEFAULT_TIMEOUT_MS = 30000;

class AppServerTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.appServerCommand || process.env.CODEX_APP_SERVER_BIN || findCodexBinary();
    this.cwd = options.cwd || process.cwd();
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.traceEnabled = options.trace === true || process.env.CODEX_IPC_TRACE === "1";
    this.traceFile = options.traceFile
      || process.env.CODEX_IPC_TRACE_FILE
      || (this.traceEnabled && process.env.CODEX_REMOTE_RUNTIME_DIR
        ? path.join(process.env.CODEX_REMOTE_RUNTIME_DIR, "codex-ipc-trace.jsonl")
        : null);
    this.child = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.buffer = "";
    this.clientId = "app-server-client";
    this.states = new Map();
    this.revisions = new Map();
    this.activeTurnIds = new Map();
  }

  async connect() {
    if (this.child) return { clientId: this.clientId };

    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.clientId = `app-server-${this.child.pid || process.pid}`;

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        this.child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        this.child.off("spawn", onSpawn);
        reject(error);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
      this.child.stdout.on("data", (chunk) => this.handleData(chunk));
      this.child.stderr.on("data", (chunk) => this.trace("stderr", {
        text: chunk.toString("utf8").replace(/\s+/g, " ").slice(0, 240)
      }));
      this.child.on("close", (code, signal) => {
        this.trace("close", { code, signal, pending: this.pending.size });
        this.child = null;
        this.rejectPending(new Error(`Codex App Server closed (${code ?? "unknown"})`));
        this.emit("close");
      });
    });

    const initialized = await this.rpc("initialize", {
      clientInfo: {
        name: "codex-remote",
        title: "Codex Remote",
        version: "1.0.1"
      }
    });
    if (!initialized || !initialized.result) {
      throw new Error("Codex App Server initialize failed");
    }
    this.write({ method: "initialized", params: {} });
    this.emit("connect");

    const listed = await this.rpc("thread/list", { limit: 100 });
    for (const thread of (listed.result && listed.result.data) || []) {
      this.setThread(thread, true);
    }
    return { clientId: this.clientId };
  }

  disconnect() {
    if (this.child) this.child.kill();
  }

  async reconnect() {
    this.disconnect();
    if (this.child) {
      await new Promise((resolve) => this.once("close", resolve));
    }
    this.buffer = "";
    return this.connect();
  }

  async request(method, params = {}) {
    if (method === "thread-follower-load-complete-history") {
      const conversationId = params.conversationId;
      const response = await this.rpc("thread/resume", { threadId: conversationId });
      const thread = response.result && response.result.thread;
      if (thread) this.setThread(thread, true);
      const state = this.states.get(conversationId);
      return { result: { revision: state ? state.revision : null, thread } };
    }

    if (method === "thread-follower-start-turn") {
      const response = await this.rpc("turn/start", params.turnStartParams || {});
      return response;
    }

    if (method === "thread-follower-interrupt-turn") {
      const conversationId = params.conversationId;
      const turnId = this.activeTurnIds.get(conversationId) || latestTurnId(this.states.get(conversationId));
      if (!turnId) throw new Error("no active turn");
      return this.rpc("turn/interrupt", { threadId: conversationId, turnId });
    }

    if (method === "thread-follower-command-approval-decision") {
      throw new Error("Codex App Server approvals must answer the pending server request");
    }

    throw new Error(`Unsupported App Server mapping: ${method}`);
  }

  async send(method, params = {}) {
    const response = await this.request(method, params);
    return { accepted: true, raw: response, method };
  }

  respondToServer(requestId, result) {
    if (!this.child) throw new Error("Codex App Server is not connected");
    this.write({ id: requestId, result });
  }

  rpc(method, params = {}) {
    if (!this.child) return Promise.reject(new Error("Codex App Server is not connected"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  write(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex App Server stdin is not writable");
    }
    this.trace("send", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleData(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.trace("parse-error", { error: error.message });
        continue;
      }
      this.trace("receive", message);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message || `Codex App Server request failed: ${pending.method}`);
          error.response = message;
          pending.reject(error);
        } else {
          pending.resolve(message);
        }
        continue;
      }
      if (message.method && message.id !== undefined) {
        this.emit("server-request", message);
        continue;
      }
      if (message.method) this.handleNotification(message);
    }
  }

  handleNotification(message) {
    const params = message.params || {};
    if (message.method === "error") {
      const error = new Error(
        params.error && params.error.message
          || params.message
          || "Codex App Server turn failed"
      );
      error.response = message;
      this.emit("notification-error", error);
      return;
    }
    const threadId = params.threadId || (params.thread && params.thread.id);
    if (!threadId) return;

    if (message.method === "thread/started") {
      this.setThread(params.thread, true);
      return;
    }
    if (message.method === "turn/started" || message.method === "turn/completed") {
      if (params.turn && params.turn.id) {
        this.activeTurnIds.set(threadId, params.turn.id);
      }
      this.updateTurn(threadId, params.turn, true);
      if (message.method === "turn/completed"
        && this.activeTurnIds.get(threadId) === (params.turn && params.turn.id)) {
        this.activeTurnIds.delete(threadId);
      }
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      this.updateItem(threadId, params.turnId, params.item, true);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      this.appendAgentDelta(threadId, params.turnId, params.itemId, params.delta || "");
      this.emitSnapshot(threadId);
    }
  }

  setThread(thread, emit) {
    if (!thread || !thread.id) return;
    const revision = this.nextRevision(thread.id);
    const state = {
      id: thread.id,
      sessionId: thread.sessionId || thread.id,
      title: thread.name || thread.preview || thread.id,
      cwd: thread.cwd || null,
      updatedAt: Number(thread.updatedAt || 0) * 1000 || null,
      turns: Array.isArray(thread.turns) ? thread.turns.map(normalizeTurn) : [],
      latestThreadSettings: thread.latestThreadSettings || null,
      currentPermissions: thread.currentPermissions || null,
      source: "app-server",
      revision
    };
    this.states.set(thread.id, state);
    if (emit) this.emitSnapshot(thread.id);
  }

  updateTurn(threadId, turn, emit) {
    if (!turn || !turn.id) return;
    const state = this.ensureState(threadId);
    const normalized = normalizeTurn(turn);
    const index = state.turns.findIndex((item) => item.turnId === normalized.turnId);
    if (index < 0) state.turns.push(normalized);
    else state.turns[index] = mergeTurn(state.turns[index], normalized);
    state.revision = this.nextRevision(threadId);
    if (emit) this.emitSnapshot(threadId);
  }

  updateItem(threadId, turnId, item, emit) {
    if (!turnId || !item || !item.id) return;
    const state = this.ensureState(threadId);
    let turn = state.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) {
      turn = { turnId, status: "running", items: [] };
      state.turns.push(turn);
    }
    const normalized = normalizeItem(item);
    const index = turn.items.findIndex((candidate) => candidate.id === normalized.id);
    if (index < 0) turn.items.push(normalized);
    else turn.items[index] = normalized;
    state.revision = this.nextRevision(threadId);
    if (emit) this.emitSnapshot(threadId);
  }

  appendAgentDelta(threadId, turnId, itemId, delta) {
    const state = this.ensureState(threadId);
    let turn = state.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) {
      turn = { turnId, status: "running", items: [] };
      state.turns.push(turn);
    }
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      item = { id: itemId, type: "agentMessage", text: "", phase: null };
      turn.items.push(item);
    }
    item.text = `${item.text || ""}${delta}`;
    state.revision = this.nextRevision(threadId);
  }

  ensureState(threadId) {
    if (!this.states.has(threadId)) {
      this.states.set(threadId, {
        id: threadId,
        sessionId: threadId,
        title: threadId,
        cwd: null,
        turns: [],
        source: "app-server",
        revision: this.nextRevision(threadId)
      });
    }
    return this.states.get(threadId);
  }

  nextRevision(threadId) {
    const revision = (this.revisions.get(threadId) || 0) + 1;
    this.revisions.set(threadId, revision);
    return revision;
  }

  emitSnapshot(threadId) {
    const state = this.states.get(threadId);
    if (!state) return;
    this.emit("broadcast", {
      type: "broadcast",
      sourceClientId: this.clientId,
      method: "thread-stream-state-changed",
      params: {
        conversationId: threadId,
        hostId: "app-server",
        change: { type: "snapshot", revision: state.revision, conversationState: state }
      }
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  trace(kind, message) {
    if (!this.traceEnabled) return;
    const safe = {
      ts: new Date().toISOString(),
      layer: "app-server-transport",
      kind,
      type: message && message.type || null,
      id: message && message.id || null,
      method: message && message.method || null,
      paramsKeys: message && message.params && typeof message.params === "object"
        ? Object.keys(message.params).sort()
        : undefined,
      text: message && message.text ? String(message.text).slice(0, 120) : undefined
    };
    const line = `${JSON.stringify(safe)}\n`;
    if (this.traceFile) {
      try {
        fs.mkdirSync(path.dirname(this.traceFile), { recursive: true });
        fs.appendFileSync(this.traceFile, line, "utf8");
      } catch {
        // Tracing must never break the transport.
      }
    }
  }
}

function normalizeTurn(turn) {
  return {
    turnId: turn.id,
    status: turn.status === "inProgress" ? "running" : turn.status,
    turnStartedAtMs: Number(turn.startedAt || 0) * 1000 || 0,
    items: Array.isArray(turn.items) ? turn.items.map(normalizeItem) : []
  };
}

function mergeTurn(previous, next) {
  const items = new Map((previous.items || []).map((item) => [item.id, item]));
  for (const item of next.items || []) items.set(item.id, item);
  return {
    ...previous,
    ...next,
    turnStartedAtMs: next.turnStartedAtMs || previous.turnStartedAtMs || 0,
    items: [...items.values()]
  };
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "agentMessage") {
    return { ...item, phase: item.phase || null, text: item.text || "" };
  }
  if (item.type === "userMessage") {
    return {
      ...item,
      content: Array.isArray(item.content) ? item.content : []
    };
  }
  return { ...item };
}

function latestTurnId(state) {
  const turns = state && Array.isArray(state.turns) ? state.turns : [];
  return turns.length > 0 ? turns[turns.length - 1].turnId : null;
}

function findCodexBinary() {
  if (process.platform !== "win32") return "codex";
  const root = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = entry.isDirectory() ? path.join(root, entry.name, "codex.exe") : path.join(root, entry.name);
      if (fs.existsSync(candidate)) candidates.push({ path: candidate, mtime: fs.statSync(candidate).mtimeMs });
    }
  } catch {
    return "codex";
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? candidates[0].path : "codex";
}

module.exports = { AppServerTransport, findCodexBinary };
