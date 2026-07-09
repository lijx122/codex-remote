"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  // Optional: state_5.sqlite filtering is skipped if better-sqlite3 is not installed
}
const { IpcTransport } = require("./ipc-transport");
const { CodexFollowerEventBus } = require("./event-bus");

const INTERRUPTED_TURN_STATUSES = new Set([
  "interrupted",
  "interrupt",
  "canceled",
  "cancelled",
  "aborted",
  "stopped"
]);

class CodexFollowerCore {
  constructor(options = {}) {
    this.transport = new IpcTransport(options);
    this.events = new CodexFollowerEventBus();
    this.threads = new Map();
    this.histories = new Map();
    this.pendingApprovals = new Map();
    this.connected = false;
    this.codexHome = options.codexHome || defaultCodexHome();

    this.transport.on("broadcast", (message) => this.handleBroadcast(message));
    this.transport.on("server-request", (message) => this.handleServerRequest(message));
    this.transport.on("error", (error) => {
      this.events.publish({ type: "error", error, raw: error });
    });
  }

  async connect() {
    const result = await this.transport.connect();
    this.connected = true;
    return result;
  }

  disconnect() {
    this.connected = false;
    this.transport.disconnect();
  }

  listThreads() {
    // Base: session_index (authoritative for what exists on disk)
    // Supplement: SQLite for threads not in index (e.g. recently created)
    // Overlay: this.threads (Desktop broadcast, live state)
    const dbRows = this.getThreadRowsFromDb();
    const dbThreadMap = new Map(dbRows.map((row) => [row.id, row]));
    const archivedIds = archivedIdsFromRows(dbRows);
    const indexEntries = this.readSessionIndex();
    const indexMap = new Map();
    for (const idx of indexEntries) {
      indexMap.set(idx.id, idx);
    }

    // Build map of rollout paths to speed up getThreadCwd and getThreadFirstMessage
    const rolloutMap = new Map();
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const rootName of ["sessions", "archived_sessions"]) {
      const root = path.join(this.codexHome, rootName);
      for (const p of walkJsonlFiles(root)) {
        const m = p.match(uuidRe);
        if (m) rolloutMap.set(m[0], p);
      }
    }

    const isUuid = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str || ""));
    const getCleanTitle = (title, id) => {
      if (!title || title === id || isUuid(title)) return null;
      return title;
    };

    const merged = new Map();

    // Pass 1: index entries (non-archived)
    for (const idx of indexEntries) {
      if (archivedIds.has(idx.id)) continue;
      if (this.isSubagentThread(idx, dbThreadMap.get(idx.id), rolloutMap)) continue;
      merged.set(idx.id, {
        id: idx.id,
        title: getCleanTitle(idx.title, idx.id) || this.getThreadFirstMessage(idx.id, rolloutMap) || idx.id,
        updatedAt: idx.updatedAt || null,
        sessionId: idx.sessionId || null,
        cwd: idx.cwd || this.getThreadCwd(idx.id, rolloutMap),
        runtimeStatus: null,
        sendable: this.threads.has(idx.id),
        raw: idx.raw || {}
      });
    }

    // Pass 2: SQLite threads not in index (catch recently created / unindexed)
    // Only include if rollout file exists in sessions/ (not archived_sessions/)
    const activeIds = this.getActiveThreadIds(rolloutMap, archivedIds);
    for (const row of dbRows) {
      if (merged.has(row.id)) continue;
      if (archivedIds.has(row.id)) continue;
      if (this.isSubagentThread(row, row, rolloutMap)) continue;
      if (!activeIds.has(row.id)) continue;
      merged.set(row.id, {
        id: row.id,
        title: getCleanTitle(row.title, row.id) || this.getThreadFirstMessage(row.id, rolloutMap) || row.id,
        updatedAt: null,
        sessionId: null,
        cwd: this.getThreadCwd(row.id, rolloutMap),
        runtimeStatus: null,
        sendable: this.threads.has(row.id),
        raw: {}
      });
    }

    // Pass 3: overlay broadcast data (always more current)
    for (const thread of this.threads.values()) {
      if (this.isSubagentThread(thread, dbThreadMap.get(thread.id), rolloutMap)) continue;
      const existing = merged.get(thread.id);
      const broadcastTitle = getCleanTitle(thread.title, thread.id);
      const existingTitle = existing && existing.title && !isUuid(existing.title) ? existing.title : null;

      merged.set(thread.id, {
        id: thread.id,
        title: broadcastTitle || existingTitle || this.getThreadFirstMessage(thread.id, rolloutMap) || thread.id,
        updatedAt: thread.updatedAt || (existing && existing.updatedAt) || null,
        sessionId: thread.sessionId || (existing && existing.sessionId) || null,
        cwd: thread.cwd || (existing && existing.cwd) || this.getThreadCwd(thread.id, rolloutMap),
        runtimeStatus: thread.runtimeStatus || null,
        sendable: true,
        raw: thread.raw || {}
      });
    }

    return [...merged.values()].sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );
  }

  getActiveThreadIds(rolloutMap, archivedIds) {
    // Only threads with a rollout file in sessions/ (not archived_sessions) are active
    // Also excludes threads marked archived=1 in state_5.sqlite
    const ids = new Set();
    if (rolloutMap) {
      for (const [id, p] of rolloutMap.entries()) {
        if (p.includes(path.sep + "sessions" + path.sep)) {
          ids.add(id);
        }
      }
    } else {
      const sessionsRoot = path.join(this.codexHome, "sessions");
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      try {
        for (const file of walkJsonlFiles(sessionsRoot)) {
          const m = file.match(uuidRe);
          if (m) ids.add(m[0]);
        }
      } catch {
        // Directory might not exist
      }
    }
    // Subtract threads archived in SQLite
    for (const id of archivedIds || this.getArchivedIdsFromDb()) {
      ids.delete(id);
    }
    return ids;
  }

  getArchivedIdsFromDb() {
    return archivedIdsFromRows(this.getThreadRowsFromDb());
  }

  getThreadRowsFromDb() {
    if (!Database) return [];
    const dbPath = path.join(this.codexHome, "state_5.sqlite");
    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      return db.prepare("SELECT * FROM threads ORDER BY rowid DESC").all();
    } catch {
      return [];
    } finally {
      if (db) db.close();
    }
  }

  getNonArchivedThreadsFromDb() {
    return this.getThreadRowsFromDb().filter((row) => Number(row.archived) !== 1);
  }

  readSessionIndex() {
    const indexPath = path.join(this.codexHome, "session_index.jsonl");
    let raw;
    try {
      raw = fs.readFileSync(indexPath, "utf8");
    } catch {
      return [];
    }

    const seen = new Set();
    const threads = [];
    // Read from newest to oldest (file is append-only), so first encounter = latest
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        threads.push({
          id: item.id,
          title: item.thread_name || item.title || null,
          updatedAt: item.updated_at || item.updatedAt || null,
          sessionId: item.session_id || item.sessionId || null,
          cwd: item.cwd || null,
          runtimeStatus: null,
          raw: item
        });
      } catch {
        // Ignore malformed index lines; Desktop may be appending concurrently.
      }
    }
    return threads;
  }

  getThreadCwd(threadId, rolloutMap) {
    // Check cache from broadcasts first
    const cached = this.threads.get(threadId);
    if (cached && cached.cwd) return cached.cwd;

    // Read first line of rollout file for session_meta.cwd
    const meta = this.readThreadMeta(threadId, rolloutMap);
    return meta && meta.cwd ? meta.cwd : null;
  }

  readThreadMeta(threadId, rolloutMap) {
    const rolloutPath = this.findRolloutPath(threadId, rolloutMap);
    if (!rolloutPath) return null;

    try {
      const fd = fs.openSync(rolloutPath, "r");
      let buf = Buffer.alloc(0);
      const chunk = Buffer.alloc(65536);
      let bytesRead;
      while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, buf.length)) > 0) {
        buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
        const newline = buf.indexOf(10); // \n
        if (newline >= 0) {
          fs.closeSync(fd);
          const firstLine = buf.toString("utf8", 0, newline);
          const entry = JSON.parse(firstLine);
          if (entry.type === "session_meta" && entry.payload) {
            return entry.payload;
          }
          return null;
        }
        if (buf.length > 524288) break; // safety: 512KB max for first line
      }
      fs.closeSync(fd);
    } catch {
      // Locked or malformed file
    }
    return null;
  }

  isSubagentThread(thread, dbThread, rolloutMap) {
    if (isSubagentRecord(thread) || isSubagentRecord(thread && thread.raw) || isSubagentRecord(dbThread)) {
      return true;
    }

    const threadId = thread && (thread.id || thread.conversationId);
    if (!threadId) return false;
    return isSubagentRecord(this.readThreadMeta(threadId, rolloutMap));
  }

  getThreadFirstMessage(threadId, rolloutMap) {
    // 1. Try to extract from memory cache first (most real-time and avoids disk IO)
    const cached = this.threads.get(threadId);
    if (cached && cached.raw && Array.isArray(cached.raw.turns)) {
      for (const turn of cached.raw.turns) {
        if (!turn || !Array.isArray(turn.items)) continue;
        for (const item of turn.items) {
          if (item.type === "userMessage" && Array.isArray(item.content)) {
            const text = item.content.map(c => c.text || "").join(" ").trim();
            if (text) return text;
          }
          if (item.role === "user" && item.text) {
            return item.text.trim();
          }
        }
      }
    }

    // 2. Fall back to reading first user message from rollout file
    const rolloutPath = this.findRolloutPath(threadId, rolloutMap);
    if (!rolloutPath) return null;

    try {
      const raw = fs.readFileSync(rolloutPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "response_item" || !entry.payload) continue;
          if (entry.payload.type !== "message" || entry.payload.role !== "user") continue;
          const content = entry.payload.content;
          if (Array.isArray(content)) {
            const text = content.map(c => c.text || "").join(" ").trim();
            if (text) return text;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Locked or malformed file
    }
    return null;
  }

  async loadHistory(conversationId) {
    this.assertConversationId(conversationId);
    try {
      const response = await this.transport.request(
        "thread-follower-load-complete-history",
        { conversationId }
      );
      const state = this.histories.get(conversationId) || this.loadLocalHistory(conversationId);
      return {
        conversationId,
        revision: response.result && response.result.revision,
        state,
        raw: response
      };
    } catch (error) {
      const state = this.loadLocalHistory(conversationId);
      if (!state) throw error;
      return {
        conversationId,
        revision: state.revision,
        state,
        raw: { source: "rollout", error: error.message || String(error) }
      };
    }
  }

  loadLocalHistory(conversationId) {
    const rolloutPath = this.findRolloutPath(conversationId);
    if (!rolloutPath) return null;

    let raw;
    try {
      raw = fs.readFileSync(rolloutPath, "utf8");
    } catch {
      return null;
    }

    const turns = [];
    let meta = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      if (item.type === "session_meta") {
        meta = item.payload || meta;
        continue;
      }
      if (item.type !== "response_item" || !item.payload) continue;

      const message = this.messageFromResponseItem(item.payload);
      if (!message) continue;
      turns.push({
        turnId: `${conversationId}-${turns.length}`,
        status: "completed",
        items: [message]
      });
    }

    const state = {
      id: conversationId,
      sessionId: conversationId,
      title: this.titleForConversation(conversationId),
      cwd: meta && meta.cwd ? meta.cwd : null,
      updatedAt: meta && meta.timestamp ? meta.timestamp : null,
      turns,
      source: "rollout",
      rolloutPath,
      revision: turns.length
    };
    this.histories.set(conversationId, state);
    return state;
  }

  messageFromResponseItem(payload) {
    if (payload.type !== "message") return null;
    if (payload.role !== "user" && payload.role !== "assistant") return null;

    const text = this.textFromResponseContent(payload.content);
    if (!text || text.startsWith("<environment_context>")) return null;

    if (payload.role === "user") {
      return {
        type: "userMessage",
        content: [{ type: "text", text }]
      };
    }
    return {
      type: "agentMessage",
      text,
      phase: payload.phase || null
    };
  }

  textFromResponseContent(content) {
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        return part.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }

  titleForConversation(conversationId) {
    const fromRuntime = this.threads.get(conversationId);
    if (fromRuntime && fromRuntime.title) return fromRuntime.title;
    const fromIndex = this.readSessionIndex().find((thread) => thread.id === conversationId);
    return fromIndex && fromIndex.title ? fromIndex.title : conversationId;
  }

  findRolloutPath(conversationId, rolloutMap) {
    if (rolloutMap && rolloutMap.has(conversationId)) {
      return rolloutMap.get(conversationId);
    }
    for (const rootName of ["sessions", "archived_sessions"]) {
      const root = path.join(this.codexHome, rootName);
      const found = findFileByName(root, conversationId);
      if (found) return found;
    }
    return null;
  }

  isThreadArchived(conversationId) {
    // Check if the rollout file is ONLY in archived_sessions (not in sessions)
    const sessionsRoot = path.join(this.codexHome, "sessions");
    const activePath = findFileByName(sessionsRoot, conversationId);
    if (activePath) return false;

    const archivedRoot = path.join(this.codexHome, "archived_sessions");
    const archivedPath = findFileByName(archivedRoot, conversationId);
    return !!archivedPath;
  }

  async warmThread(conversationId) {
    this.assertConversationId(conversationId);

    // Already loaded — nothing to do
    const alreadyKnown = this.threads.has(conversationId);
    const openResult = await openThreadDeepLink(conversationId);
    if (!openResult.ok) return openResult;

    const broadcastResult = await new Promise((resolve) => {
      const timeoutMs = alreadyKnown ? 3000 : 15000;
      const timer = setTimeout(() => {
        this.transport.off("broadcast", onBroadcast);
        resolve({ ok: false, timeout: true });
      }, timeoutMs);

      const onBroadcast = (message) => {
        if (message.method !== "thread-stream-state-changed") return;
        const params = message.params || {};
        if (params.conversationId === conversationId) {
          clearTimeout(timer);
          this.transport.off("broadcast", onBroadcast);
          // Give a small grace period for the handler to update this.threads
          setImmediate(() => resolve({ ok: true, alreadyLoaded: false }));
        }
      };

      this.transport.on("broadcast", onBroadcast);
    });
    if (!broadcastResult.ok && !this.threads.has(conversationId)) return broadcastResult;
    await sleep(1500);
    return {
      ok: true,
      alreadyLoaded: alreadyKnown,
      broadcast: broadcastResult.ok,
      sendable: this.threads.has(conversationId)
    };
  }

  async sendMessage(conversationId, text) {
    this.assertConversationId(conversationId);
    if (!text || typeof text !== "string") {
      throw new Error("text is required");
    }
    const history = await this.loadHistory(conversationId);
    const turnStartParams = this.buildStartTurnParams(conversationId, text, history.state);
    const response = await this.transport.request(
      "thread-follower-start-turn",
      { conversationId, turnStartParams }
    );
    this.events.publish({
      type: "message",
      conversationId,
      role: "user",
      text,
      raw: response
    });
    return { ok: true, raw: response };
  }

  async interrupt(conversationId) {
    this.assertConversationId(conversationId);
    const response = await this.transport.request(
      "thread-follower-interrupt-turn",
      { conversationId }
    );
    this.events.publish({ type: "interrupt", conversationId, raw: response });
    return { ok: true, raw: response };
  }

  async approve(conversationId, approvalId, decision) {
    this.assertConversationId(conversationId);
    if (!approvalId) {
      throw new Error("approvalId is required");
    }
    if (decision !== "allow" && decision !== "deny") {
      throw new Error("decision must be allow or deny");
    }

    // Look up the original server request to respond with the correct ID
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      this.pendingApprovals.delete(approvalId);
      const result = this.buildApprovalResult(pending.method, decision);
      this.transport.respondToServer(pending.requestId, result);
      this.events.publish({
        type: "approval_response",
        conversationId,
        approvalId,
        decision,
        raw: { requestId: pending.requestId, result }
      });
      return { ok: true, responded: true };
    }

    // Fallback: send as a new request
    const response = await this.transport.request(
      "thread-follower-command-approval-decision",
      { conversationId, approvalId, decision }
    );
    this.events.publish({
      type: "approval_response",
      conversationId,
      approvalId,
      decision,
      raw: response
    });
    return { ok: true, raw: response };
  }

  buildApprovalResult(method, decision) {
    const allow = decision === "allow";
    if (method && method.includes("commandExecution")) {
      return { decision: allow ? "accept" : "decline" };
    }
    if (method && method.includes("fileChange")) {
      return { decision: allow ? "accept" : "decline" };
    }
    if (method && method.includes("permissions")) {
      return allow
        ? { permissions: { fileSystem: {}, network: {} }, scope: "turn", strictAutoReview: false }
        : { permissions: {}, scope: "turn", strictAutoReview: false };
    }
    return { decision: allow ? "allow" : "deny" };
  }

  handleServerRequest(message) {
    const method = message.method || "";
    const params = message.params || {};

    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      layer: "follower-core",
      event: "server-request",
      method,
      keys: Object.keys(params)
    }));

    // Desktop sends threadId, not conversationId, in approval params
    const conversationId = params.conversationId || params.threadId || "";

    // Approval requests from Desktop
    if (method.includes("requestApproval") || method.includes("request_approval")) {
      const approvalId = params.approvalId || params.itemId || params.id || message.id || "";
      this.pendingApprovals.set(approvalId, {
        requestId: message.id,
        method,
        params,
        createdAt: Date.now()
      });

      this.events.publish({
        type: "approval_request",
        conversationId,
        approvalId,
        method,
        raw: message
      });
      return;
    }

    // Other server requests — log and ignore for now
    this.events.publish({
      type: "message",
      conversationId,
      raw: message
    });
  }

  subscribeEvents(conversationId) {
    this.assertConversationId(conversationId);
    const scoped = new CodexFollowerEventBus();
    const forward = (event) => {
      if (!event.conversationId || event.conversationId === conversationId) {
        scoped.publish(event);
      }
    };
    this.events.on("*", forward);
    scoped.unsubscribe = () => this.events.off("*", forward);
    return scoped;
  }

  handleBroadcast(message) {
    if (message.method !== "thread-stream-state-changed") {
      return;
    }

    const params = message.params || {};
    const conversationId = params.conversationId;
    const change = params.change || {};
    const state = change.conversationState;

    if (state && conversationId) {
      this.histories.set(conversationId, state);
      this.threads.set(conversationId, {
        id: conversationId,
        title: state.title || null,
        updatedAt: state.updatedAt || state.recencyAt || state.createdAt || null,
        sessionId: state.sessionId || null,
        cwd: state.cwd || null,
        runtimeStatus: state.threadRuntimeStatus || null,
        raw: state
      });
    }

    this.events.publish({
      type: "thread_state_changed",
      conversationId,
      revision: change.revision,
      state: state || null,
      raw: message
    });

    this.publishTurnEvents(conversationId, state, message);
  }

  publishTurnEvents(conversationId, state, raw) {
    if (!conversationId || !state || !Array.isArray(state.turns)) {
      return;
    }
    const lastTurn = state.turns[state.turns.length - 1];
    if (!lastTurn) return;

    const status = lastTurn.status || "";

    if (status === "running" || status === "inProgress") {
      this.events.publish({
        type: "turn_started",
        conversationId,
        turnId: lastTurn.turnId,
        raw
      });
    } else if (status === "completed") {
      this.events.publish({
        type: "turn_completed",
        conversationId,
        turnId: lastTurn.turnId,
        raw
      });
    } else if (isInterruptedTurnStatus(status)) {
      this.events.publish({
        type: "turn_interrupted",
        conversationId,
        turnId: lastTurn.turnId,
        status,
        raw
      });
    }
  }

  assertConversationId(conversationId) {
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error("conversationId is required");
    }
  }

  buildStartTurnParams(conversationId, text, state) {
    const settings = state && state.latestThreadSettings ? state.latestThreadSettings : {};
    const permissions = state && state.currentPermissions ? state.currentPermissions : {};
    return {
      threadId: conversationId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: settings.approvalPolicy || permissions.approvalPolicy || "never",
      approvalsReviewer: settings.approvalsReviewer || permissions.approvalsReviewer || "user",
      sandboxPolicy: settings.sandboxPolicy || permissions.sandboxPolicy || { type: "workspaceWrite" },
      model: settings.model || null,
      cwd: settings.cwd || (state && state.cwd) || null,
      attachments: [],
      effort: settings.effort || null,
      summary: settings.summary || "none",
      personality: settings.personality || null,
      outputSchema: null,
      collaborationMode: settings.collaborationMode || null
    };
  }
}

function createCodexFollower(options) {
  return new CodexFollowerCore(options);
}

function openThreadDeepLink(conversationId) {
  return new Promise((resolve) => {
    const { exec } = require("node:child_process");
    const url = `codex://threads/${conversationId}`;
    exec(
      `start "" "${url}"`,
      { windowsHide: true, shell: "cmd.exe" },
      (error) => {
        resolve(error ? { ok: false, error: error.message } : { ok: true });
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInterruptedTurnStatus(status) {
  return INTERRUPTED_TURN_STATUSES.has(String(status || "").toLowerCase());
}

function archivedIdsFromRows(rows) {
  return new Set((rows || [])
    .filter((row) => row && Number(row.archived) === 1)
    .map((row) => row.id)
    .filter(Boolean));
}

function isSubagentRecord(record) {
  if (!record || typeof record !== "object") return false;

  const threadSource = record.thread_source || record.threadSource;
  if (String(threadSource || "").toLowerCase() === "subagent") return true;

  const source = record.source;
  if (!source) return false;

  if (typeof source === "string") {
    try {
      return isSubagentSource(JSON.parse(source));
    } catch {
      return source.toLowerCase().includes("subagent");
    }
  }

  return isSubagentSource(source);
}

function isSubagentSource(source) {
  if (!source || typeof source !== "object") return false;
  if (source.subagent) return true;
  return String(source.thread_source || source.threadSource || "").toLowerCase() === "subagent";
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function findFileByName(root, text) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(text) && entry.name.endsWith(".jsonl")) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, text);
      if (found) return found;
    }
  }
  return null;
}

function walkJsonlFiles(root) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(fullPath));
    }
  }
  return files;
}

module.exports = {
  CodexFollowerCore,
  CodexFollowerEventBus,
  createCodexFollower
};
