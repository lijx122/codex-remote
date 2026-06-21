"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IpcTransport } = require("./ipc-transport");
const { CodexFollowerEventBus } = require("./event-bus");

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
    const threads = new Map();
    for (const thread of this.readSessionIndex()) {
      threads.set(thread.id, thread);
    }
    for (const thread of this.threads.values()) {
      threads.set(thread.id, { ...(threads.get(thread.id) || {}), ...thread });
    }
    return Array.from(threads.values())
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((thread) => ({ ...thread }));
  }

  readSessionIndex() {
    const indexPath = path.join(this.codexHome, "session_index.jsonl");
    let raw;
    try {
      raw = fs.readFileSync(indexPath, "utf8");
    } catch {
      return [];
    }

    const threads = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;
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

  findRolloutPath(conversationId) {
    for (const rootName of ["sessions", "archived_sessions"]) {
      const root = path.join(this.codexHome, rootName);
      const found = findFileByName(root, conversationId);
      if (found) return found;
    }
    return null;
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

module.exports = {
  CodexFollowerCore,
  CodexFollowerEventBus,
  createCodexFollower
};
