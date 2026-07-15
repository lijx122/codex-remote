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
const { AppServerTransport } = require("./app-server-transport");
const { CodexFollowerEventBus } = require("./event-bus");

const INTERRUPTED_TURN_STATUSES = new Set([
  "interrupted",
  "interrupt",
  "canceled",
  "cancelled",
  "aborted",
  "stopped",
  "failed",
  "error"
]);

class CodexFollowerCore {
  constructor(options = {}) {
    const transportMode = options.transportMode || process.env.CODEX_TRANSPORT || "app-server";
    this.transport = options.transport
      || (transportMode === "ipc" ? new IpcTransport(options) : new AppServerTransport(options));
    this.events = new CodexFollowerEventBus();
    this.threads = new Map();
    this.histories = new Map();
    this.streamStates = new Map();
    this.pendingApprovals = new Map();
    this.lastPublishedTurnEvents = new Map();
    this.resyncPromise = null;
    this.connected = false;
    this.codexHome = options.codexHome || defaultCodexHome();
    this.openThread = options.openThread || openThreadDeepLink;

    this.transport.on("broadcast", (message) => this.handleBroadcast(message));
    this.transport.on("server-request", (message) => this.handleServerRequest(message));
    this.transport.on("close", () => {
      this.connected = false;
    });
    this.transport.on("error", (error) => {
      this.events.publish({ type: "error", error, raw: error });
    });
    this.transport.on("notification-error", (error) => {
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
      const state = this.mergeWithLocalHistory(
        this.histories.get(conversationId),
        this.loadLocalHistory(conversationId)
      );
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
    const turnsById = new Map();
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
      if (item.type === "event_msg" && item.payload) {
        const payload = item.payload;
        const turnId = payload.turn_id || payload.turnId;
        if (!turnId) continue;
        const turn = ensureLocalTurn(turns, turnsById, turnId, item.timestamp);
        if (payload.type === "task_started") {
          turn.status = "running";
        } else if (payload.type === "task_complete") {
          turn.status = "completed";
        } else if (payload.type === "turn_aborted") {
          turn.status = "interrupted";
        }
        continue;
      }
      if (item.type !== "response_item" || !item.payload) continue;

      const message = this.messageFromResponseItem(item.payload);
      if (!message) continue;
      const turnId = message.turnId || `${conversationId}-${turns.length}`;
      const turn = ensureLocalTurn(turns, turnsById, turnId, item.timestamp);
      turn.items.push(message);
    }

    for (const turn of turns) {
      if (!turn.status) turn.status = "unknown";
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
    const turnId = payload.internal_chat_message_metadata_passthrough
      && payload.internal_chat_message_metadata_passthrough.turn_id
      ? payload.internal_chat_message_metadata_passthrough.turn_id
      : null;

    if (payload.role === "user") {
      return {
        type: "userMessage",
        turnId,
        content: [{ type: "text", text }]
      };
    }
    return {
      type: "agentMessage",
      turnId,
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

    const alreadyKnown = this.threads.has(conversationId);
    if (alreadyKnown) {
      return {
        ok: true,
        conversationId,
        alreadyLoaded: true,
        broadcast: false,
        sendable: true
      };
    }
    const openResult = await this.openThread(conversationId);
    if (!openResult.ok) return { ...openResult, conversationId, sendable: false };

    let stopWaiting;
    const broadcastResult = await new Promise((resolve) => {
      const timeoutMs = alreadyKnown ? 3000 : 15000;
      const timer = setTimeout(() => {
        this.transport.off("broadcast", onBroadcast);
        resolve({ ok: false, timeout: true });
      }, timeoutMs);

      const onBroadcast = (message) => {
        if (message.method !== "thread-stream-state-changed") return;
        const params = message.params || {};
        if (params.conversationId === conversationId && this.threads.has(conversationId)) {
          clearTimeout(timer);
          this.transport.off("broadcast", onBroadcast);
          resolve({ ok: true, alreadyLoaded: false });
        }
      };

      this.transport.on("broadcast", onBroadcast);
      stopWaiting = (result) => {
        clearTimeout(timer);
        this.transport.off("broadcast", onBroadcast);
        resolve(result);
      };
      this.transport.reconnect()
        .then(() => {
          this.connected = true;
        })
        .catch((error) => {
          stopWaiting({ ok: false, error: error.message });
        });
    });
    if (!this.threads.has(conversationId)) {
      return { ...broadcastResult, conversationId, sendable: false };
    }
    return {
      ok: true,
      conversationId,
      alreadyLoaded: alreadyKnown,
      broadcast: broadcastResult.ok,
      sendable: true
    };
  }

  async sendMessage(conversationId, text) {
    this.assertConversationId(conversationId);
    if (!text || typeof text !== "string") {
      throw new Error("text is required");
    }
    let response;
    try {
      response = await this.sendMessageOnce(conversationId, text);
    } catch (error) {
      if (!isMissingDesktopClientError(error)) throw error;
      this.threads.delete(conversationId);
      this.streamStates.delete(conversationId);
      const warmResult = await this.warmThread(conversationId);
      if (!warmResult.ok || !warmResult.sendable) throw error;
      response = await this.sendMessageOnce(conversationId, text);
    }
    this.events.publish({
      type: "message",
      conversationId,
      role: "user",
      text,
      raw: response
    });
    return { ok: true, raw: response };
  }

  async sendMessageOnce(conversationId, text) {
    const history = await this.loadHistory(conversationId);
    const turnStartParams = this.buildStartTurnParams(conversationId, text, history.state);
    return this.transport.send(
      "thread-follower-start-turn",
      { conversationId, turnStartParams }
    );
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
    if (message.method === "ipc-connection-reset") {
      this.threads.clear();
      this.streamStates.clear();
      this.publishDiagnostic("ipc-connection-reset", null, message);
      return;
    }

    if (message.method === "thread-stream-following-changed") {
      this.handleFollowingChanged(message);
      return;
    }

    if (message.method !== "thread-stream-state-changed") {
      return;
    }

    const params = message.params || {};
    const conversationId = params.conversationId;
    const change = params.change || {};
    if (!conversationId) {
      this.publishDiagnostic("stream-missing-conversation-id", null, message);
      return;
    }

    const owner = message.sourceClientId || params.sourceClientId || null;
    const tracked = this.streamStates.get(conversationId);
    const ownerChanged = tracked && tracked.owner && owner && tracked.owner !== owner;
    if (ownerChanged && !isSnapshotChange(change)) {
      this.invalidateLiveThread(conversationId, "stream-owner-changed", message, {
        owner,
        revision: null,
        following: tracked.following !== false
      });
      return;
    }
    if (tracked && tracked.following === false) {
      this.invalidateLiveThread(conversationId, "stream-not-following", message, tracked);
      return;
    }

    let state;
    const revision = change.revision;
    if (!change.type && Object.prototype.hasOwnProperty.call(change, "conversationState")) {
      state = change.conversationState;
    } else if (change.type === "snapshot") {
      if (!change.conversationState || typeof change.conversationState !== "object") {
        this.invalidateLiveThread(conversationId, "invalid-stream-snapshot", message, tracked);
        return;
      }
      if (tracked && tracked.owner === owner && tracked.revision === revision) return;
      state = change.conversationState;
    } else if (isPatchChange(change)) {
      const patches = patchListFromChange(change);
      if (tracked && tracked.revision === revision) return;
      if (
        !tracked
        || tracked.revision !== change.baseRevision
        || !Number.isInteger(change.baseRevision)
        || !Number.isInteger(revision)
        || revision !== change.baseRevision + 1
      ) {
        this.invalidateLiveThread(conversationId, "stream-revision-gap", message, tracked);
        return;
      }
      try {
        state = applyStatePatches(this.histories.get(conversationId), patches);
      } catch (error) {
        this.invalidateLiveThread(conversationId, "stream-patch-failed", message, tracked, error);
        this.requestStreamResync(conversationId);
        return;
      }
    } else {
      this.invalidateLiveThread(conversationId, "unsupported-stream-change", message, tracked);
      return;
    }

    if (!state || typeof state !== "object") {
      this.invalidateLiveThread(conversationId, "invalid-stream-state", message, tracked);
      return;
    }

    const storedState = Number.isInteger(revision) ? { ...state, revision } : state;
    this.histories.set(conversationId, storedState);
    this.streamStates.set(conversationId, {
      owner: owner || (tracked && tracked.owner) || null,
      revision: Number.isInteger(revision) ? revision : null,
      following: true
    });
    this.threads.set(conversationId, threadFromState(conversationId, storedState));

    this.events.publish({
      type: "thread_state_changed",
      conversationId,
      revision,
      state: storedState,
      raw: message
    });

    this.publishTurnEvents(conversationId, storedState, message);
  }

  handleFollowingChanged(message) {
    const params = message.params || {};
    const conversationId = params.conversationId;
    const following = params.following ?? params.isFollowing ?? (params.change && params.change.following);
    if (conversationId) {
      const tracked = this.streamStates.get(conversationId) || { owner: null, revision: null };
      this.streamStates.set(conversationId, { ...tracked, following: following !== false });
      if (following === false) this.threads.delete(conversationId);
    }
    this.publishDiagnostic(
      following === false ? "thread-stream-following-stopped" : "thread-stream-following-changed",
      conversationId,
      message
    );
  }

  invalidateLiveThread(conversationId, code, raw, streamState, error) {
    this.threads.delete(conversationId);
    if (streamState) this.streamStates.set(conversationId, streamState);
    this.publishDiagnostic(code, conversationId, raw, error);
  }

  requestStreamResync(conversationId) {
    if (this.resyncPromise) return;
    this.resyncPromise = Promise.resolve()
      .then(() => this.transport.reconnect())
      .then((result) => {
        this.connected = true;
        return result;
      })
      .catch((error) => this.publishDiagnostic("stream-resync-failed", conversationId, null, error))
      .finally(() => {
        this.resyncPromise = null;
      });
  }

  publishDiagnostic(code, conversationId, raw, error) {
    this.events.publish({
      type: "diagnostic",
      code,
      conversationId: conversationId || undefined,
      message: error ? error.message : code,
      error,
      raw
    });
  }

  publishTurnEvents(conversationId, state, raw) {
    if (!conversationId || !state) {
      return;
    }
    const broadcastTurns = turnsFromState(state);
    const broadcastLastTurn = broadcastTurns[broadcastTurns.length - 1] || null;
    const broadcastStatus = broadcastLastTurn ? (broadcastLastTurn.status || "") : "";

    if (broadcastStatus === "running" || broadcastStatus === "inProgress") {
      this.publishTurnEventOnce(conversationId, "turn_started", broadcastLastTurn, broadcastStatus, raw, {
        type: "turn_started",
        raw
      });
      return;
    }

    if (broadcastStatus === "completed" && hasFinalAssistant(broadcastLastTurn)) {
      this.publishTurnEventOnce(conversationId, "turn_completed", broadcastLastTurn, "completed", raw, {
        type: "turn_completed",
        raw
      });
      return;
    }

    if (isInterruptedTurnStatus(broadcastStatus)) {
      this.publishTurnEventOnce(conversationId, "turn_interrupted", broadcastLastTurn, broadcastStatus, raw, {
        type: "turn_interrupted",
        status: broadcastStatus,
        raw
      });
      return;
    }

    if (state.source === "rollout" || state.source === "merged-rollout") {
      const localCompletedTurn = latestLocalFinalTurn(state);
      if (localCompletedTurn) {
        this.publishTurnEventOnce(conversationId, "turn_completed", localCompletedTurn, "completed", raw, {
          type: "turn_completed",
          raw
        });
      }
    }
  }

  publishTurnEventOnce(conversationId, eventType, turn, status, raw, event) {
    if (!turn || !turn.turnId) return;
    const key = `${eventType}:${turn.turnId}:${status || ""}`;
    if (this.lastPublishedTurnEvents.get(conversationId) === key) return;
    this.lastPublishedTurnEvents.set(conversationId, key);
    this.events.publish({
      ...event,
      conversationId,
      turnId: turn.turnId,
      raw
    });
  }

  mergeWithLocalHistory(liveState, localState) {
    if (!localState || !Array.isArray(localState.turns) || localState.turns.length === 0) {
      return liveState || localState;
    }
    if (!liveState) return localState;
    return {
      ...liveState,
      turns: localState.turns,
      turnHistory: null,
      source: "merged-rollout",
      rolloutPath: localState.rolloutPath,
      revision: localState.revision
    };
  }

  assertConversationId(conversationId) {
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error("conversationId is required");
    }
  }

  buildStartTurnParams(conversationId, text, state) {
    const settings = state && state.latestThreadSettings ? state.latestThreadSettings : {};
    const permissions = state && state.currentPermissions ? state.currentPermissions : {};
    const approvalPolicy = process.env.CODEX_APPROVAL_POLICY
      || settings.approvalPolicy
      || permissions.approvalPolicy
      || "untrusted";
    return {
      threadId: conversationId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy,
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

function threadFromState(conversationId, state) {
  return {
    id: conversationId,
    title: state.title || null,
    updatedAt: state.updatedAt || state.recencyAt || state.createdAt || null,
    sessionId: state.sessionId || null,
    cwd: state.cwd || null,
    runtimeStatus: state.threadRuntimeStatus || null,
    raw: state
  };
}

function applyStatePatches(previous, patches) {
  if (!previous || typeof previous !== "object" || !Array.isArray(patches)) {
    throw new Error("patch baseline or patches are invalid");
  }
  let state = structuredClone(previous);
  for (const patch of patches) state = applyStatePatch(state, patch);
  return state;
}

function applyStatePatch(state, patch) {
  const path = patch && normalizePatchPath(patch.path);
  if (!patch || !["add", "replace", "remove"].includes(patch.op) || !path) {
    throw new Error("invalid patch operation");
  }
  if (path.length === 0) {
    if (patch.op === "remove") throw new Error("cannot remove conversation state root");
    if (!patch.value || typeof patch.value !== "object") throw new Error("invalid conversation state root");
    return structuredClone(patch.value);
  }
  let parent = state;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];
    assertSafePatchSegment(segment);
    if (!parent || typeof parent !== "object") {
      throw new Error("patch path does not exist");
    }
    if (Array.isArray(parent)) {
      const arrayIndex = segment === "-" ? -1 : Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) throw new Error("invalid array patch index");
      if (parent[arrayIndex] === undefined || parent[arrayIndex] === null) {
        if (patch.op !== "add") throw new Error("patch path does not exist");
        parent[arrayIndex] = createPatchContainer(nextSegment);
      }
    } else if (!Object.prototype.hasOwnProperty.call(parent, segment) || parent[segment] === null) {
      if (patch.op !== "add") throw new Error("patch path does not exist");
      parent[segment] = createPatchContainer(nextSegment);
    }
    parent = parent[segment];
  }
  const key = path[path.length - 1];
  assertSafePatchSegment(key);
  if (!parent || typeof parent !== "object") throw new Error("patch parent is invalid");

  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0) throw new Error("invalid array patch index");
    if (patch.op === "add") {
      if (index > parent.length) throw new Error("array add index is out of range");
      parent.splice(index, 0, structuredClone(patch.value));
      return state;
    }
    if (index >= parent.length) throw new Error("array patch index is out of range");
    if (patch.op === "remove") parent.splice(index, 1);
    else parent[index] = structuredClone(patch.value);
    return state;
  }

  const exists = Object.prototype.hasOwnProperty.call(parent, key);
  if (patch.op !== "add" && !exists) throw new Error("patch target does not exist");
  if (patch.op === "remove") delete parent[key];
  else parent[key] = structuredClone(patch.value);
  return state;
}

function normalizePatchPath(path) {
  if (Array.isArray(path)) return path.map((segment) => String(segment));
  if (typeof path !== "string") return null;
  if (!path) return [];
  const segments = path.startsWith("/") ? path.slice(1).split("/") : path.split("/");
  return segments.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function createPatchContainer(nextSegment) {
  return /^\d+$/.test(String(nextSegment)) ? [] : {};
}

function isSnapshotChange(change) {
  return change && (
    change.type === "snapshot"
    || (!change.type && Object.prototype.hasOwnProperty.call(change, "conversationState"))
  );
}

function isPatchChange(change) {
  return change && (
    change.type === "patch"
    || change.type === "patches"
    || Array.isArray(change.patch)
    || Array.isArray(change.patches)
  );
}

function patchListFromChange(change) {
  if (Array.isArray(change.patches)) return change.patches;
  if (Array.isArray(change.patch)) return change.patch;
  return [];
}

function assertSafePatchSegment(segment) {
  if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
    throw new Error("unsafe patch path");
  }
}

function isMissingDesktopClientError(error) {
  const message = [
    error && error.message,
    error && error.response && error.response.error
  ].filter(Boolean).join(" ");
  return /no-client-found|no client found|not found|not open|未在\s*Desktop\s*中打开|Desktop.*(?:未打开|离线)/i.test(message);
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

function isInterruptedTurnStatus(status) {
  return INTERRUPTED_TURN_STATUSES.has(String(status || "").toLowerCase());
}

function turnsFromState(state) {
  if (!state || typeof state !== "object") return [];

  const entities = state.turnHistory && state.turnHistory.history && state.turnHistory.history.entitiesByKey;
  if (!entities || typeof entities !== "object") return Array.isArray(state.turns) ? state.turns : [];

  const canonicalTurns = Object.entries(entities)
    .filter(([key, value]) => key.startsWith("turn:") && value && typeof value === "object")
    .map(([, value]) => value)
    .sort((a, b) => {
      const aStarted = Number(a.turnStartedAtMs || 0);
      const bStarted = Number(b.turnStartedAtMs || 0);
      if (aStarted !== bStarted) return aStarted - bStarted;
      return String(a.turnId || "").localeCompare(String(b.turnId || ""));
    });
  return canonicalTurns.length > 0 ? canonicalTurns : (Array.isArray(state.turns) ? state.turns : []);
}

function latestLocalFinalTurn(state) {
  const turns = turnsFromState(state);
  if (turns.length === 0) return null;
  const latest = turns[turns.length - 1];
  if (!latest || latest.status !== "completed") return null;
  return hasFinalAssistant(latest) ? latest : null;
}

function ensureLocalTurn(turns, turnsById, turnId, timestamp) {
  if (turnsById.has(turnId)) return turnsById.get(turnId);
  const startedMs = Date.parse(timestamp || "");
  const turn = {
    turnId,
    status: "",
    turnStartedAtMs: Number.isFinite(startedMs) ? startedMs : 0,
    items: []
  };
  turnsById.set(turnId, turn);
  turns.push(turn);
  return turn;
}

function hasFinalAssistant(turn) {
  if (!turn) return false;
  return (turn.items || []).some((item) =>
    item
    && item.type === "agentMessage"
    && item.text
    && (item.phase === "final_answer" || !item.phase)
  );
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
