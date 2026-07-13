"use strict";

function splitMessage(text, maxLen = 1500) {
  const value = String(text || "");
  if (value.length <= maxLen) return [value];

  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    chunks.push(value.slice(cursor, cursor + maxLen));
    cursor += maxLen;
  }

  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
}

function relativeTime(value, now = Date.now()) {
  if (!value) return "未知";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";

  const diffMs = Math.max(0, now - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}小时前`;
  if (diffMs < 2 * day) return "昨天";
  return `${Math.floor(diffMs / day)}天前`;
}

function formatThread(thread, index, now = Date.now()) {
  const rawTitle = thread.title || thread.conversationId || "未命名会话";
  // Strip newlines, truncate — SQLite stores full first message as title
  const title = rawTitle.replace(/\r?\n/g, " ");
  const display = title.length > 40 ? title.slice(0, 40) + "…" : title;
  const id = thread.conversationId || thread.id || "";
  const tag = thread.sendable ? "●" : "○";
  return [
    `${index + 1}. ${tag} ${display}`,
    `   ${id.slice(0, 8)}`,
    `   ${relativeTime(thread.updatedAt, now)}`
  ].join("\n");
}

function findThreadByPrefixOrIndex(threads, prefix) {
  const needle = String(prefix || "").trim().toLowerCase();
  if (!needle) return null;

  // Try to parse as an index if it's purely a number
  if (/^\d+$/.test(needle)) {
    const idx = parseInt(needle, 10) - 1;
    if (idx >= 0 && idx < threads.length) {
      return threads[idx];
    }
  }

  // Otherwise, fallback to prefix matching
  return threads.find((thread) => {
    const id = String(thread.conversationId || thread.id || "").toLowerCase();
    return id === needle || id.startsWith(needle);
  }) || null;
}

function flattenHistory(state) {
  const messages = [];
  const items = state && Array.isArray(state.items) ? state.items : [];

  if (items.length > 0) {
    // New daily_server.py flat format
    for (const item of items) {
      if (item.type === "userMessage" || item.role === "user") {
        messages.push({ role: "User", text: item.text, turnId: null });
      } else if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "message" || item.role === "assistant") {
        if (item.text) {
          messages.push({ role: "Assistant", text: item.text, turnId: null });
        }
      }
    }
  } else {
    // Old deeply nested format
    const turns = turnsFromState(state);
    for (const turn of turns) {
      for (const item of turn.items || []) {
        if (item.type === "userMessage") {
          const text = (item.content || []).map((part) => part.text || "").filter(Boolean).join("\n");
          if (text) messages.push({ role: "User", text, turnId: turn.turnId || null });
        } else if (item.type === "agentMessage") {
          const text = item.text || "";
          if (text) messages.push({ role: "Assistant", text, turnId: turn.turnId || null, phase: item.phase || null });
        }
      }
    }
  }
  return messages;
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

function latestAssistantMessage(state) {
  const messages = flattenHistory(state);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "Assistant" && (message.phase === "final_answer" || !message.phase)) return message;
  }
  return null;
}

function latestAssistantMessageForTurn(state, turnId) {
  const expectedTurnId = String(turnId || "");
  if (!expectedTurnId) return latestAssistantMessage(state);

  const turn = turnsFromState(state).find(
    (candidate) => String(candidate && candidate.turnId || "") === expectedTurnId
  );
  if (!turn) return null;

  const items = Array.isArray(turn.items) ? turn.items : [];
  let fallback = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.type !== "agentMessage" || !item.text) continue;
    const message = {
      role: "Assistant",
      text: item.text,
      turnId: expectedTurnId,
      phase: item.phase || null
    };
    if (!fallback) fallback = message;
    if (item.phase === "final_answer") return message;
  }
  return fallback;
}

function summarizeAssistantMessage(text, maxLen = 500) {
  const value = String(text || "").trim();
  if (!value) return "无最终回复内容";

  const summary = extractSummarySection(value);
  const source = summary || value;
  if (source.length <= maxLen) return source;
  return `${source.slice(0, maxLen).trim()}...`;
}

function extractSummarySection(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{0,3}\s*summary\s*$/i.test(line.trim()));
  if (start < 0) return "";

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,3}\s+\S/.test(line) && collected.length > 0) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function historyText(state, count = 20) {
  const messages = flattenHistory(state).slice(-count);
  if (messages.length === 0) return "暂无历史消息";
  return messages.map((message) => `${message.role}:\n${message.text}`).join("\n\n");
}

function findThreadByPrefix(threads, prefix) {
  return findThreadByPrefixOrIndex(threads, prefix);
}

function errorMessage(error) {
  if (!error) return "未知错误";
  if (error.message) return error.message;
  return String(error);
}

function approvalText(payload) {
  const raw = payload && payload.raw ? payload.raw : payload;
  const approvalId = payload && payload.approvalId ? payload.approvalId : findFirstValue(raw, ["approvalId", "id"]);
  const content = findFirstValue(raw, [
    "command",
    "cmd",
    "description",
    "title",
    "message",
    "reason",
    "name"
  ]);

  return {
    approvalId,
    content: String(content || "请在 Desktop 查看审批详情").slice(0, 800)
  };
}

function findFirstValue(value, keys) {
  const seen = new Set();
  const queue = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    for (const key of keys) {
      if (typeof current[key] === "string" && current[key]) return current[key];
    }
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return "";
}

module.exports = {
  approvalText,
  errorMessage,
  findThreadByPrefix,
  flattenHistory,
  formatThread,
  historyText,
  latestAssistantMessage,
  latestAssistantMessageForTurn,
  relativeTime,
  splitMessage,
  summarizeAssistantMessage,
  turnsFromState
};
