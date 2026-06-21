"use strict";

const state = {
  baseUrl: localStorage.getItem("codexControlPlaneUrl") || defaultBaseUrl(),
  conversationId: "",
  socket: null,
  pendingMessages: []
};

const els = {
  controlPlaneUrl: document.getElementById("controlPlaneUrl"),
  refreshThreads: document.getElementById("refreshThreads"),
  threads: document.getElementById("threads"),
  currentTitle: document.getElementById("currentTitle"),
  status: document.getElementById("status"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  send: document.getElementById("send"),
  interrupt: document.getElementById("interrupt"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebar: document.getElementById("sidebar"),
};

els.controlPlaneUrl.value = state.baseUrl.replace(/^https?:\/\//, "");
els.controlPlaneUrl.addEventListener("change", saveBaseUrl);
els.refreshThreads.addEventListener("click", loadThreads);
els.composer.addEventListener("submit", sendMessage);
els.interrupt.addEventListener("click", interruptTurn);
els.messageInput.addEventListener("input", autoResize);
els.sidebarToggle.addEventListener("click", () => els.sidebar.classList.toggle("open"));

loadThreads();

function defaultBaseUrl() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    return `${location.protocol}//${location.hostname}:8787`;
  }
  return "http://127.0.0.1:8787";
}

function saveBaseUrl() {
  const raw = els.controlPlaneUrl.value.trim();
  state.baseUrl = raw.startsWith("http") ? raw.replace(/\/$/, "") : `http://${raw.replace(/\/$/, "")}`;
  localStorage.setItem("codexControlPlaneUrl", state.baseUrl);
  setStatus("");
  loadThreads();
}

async function api(path, options = {}) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

/* ── Thread list ── */

async function loadThreads() {
  try {
    setStatus("");
    const threads = await api("/threads");
    els.threads.innerHTML = "";
    if (threads.length === 0) {
      els.threads.innerHTML = '<div class="empty-state">暂无会话</div>';
      return;
    }
    for (const thread of threads) {
      els.threads.appendChild(buildThreadCard(thread));
    }
  } catch (error) {
    setStatus(error.message);
  }
}

function buildThreadCard(thread) {
  const card = document.createElement("button");
  card.className = "thread-card";
  card.addEventListener("click", () => openThread(thread));

  const title = document.createElement("div");
  title.className = "thread-title";
  title.textContent = thread.title || thread.conversationId;

  const meta = document.createElement("div");
  meta.className = "thread-meta";

  const dot = document.createElement("span");
  dot.className = "thread-meta-dot";
  if (thread.runtimeStatus === "running") dot.classList.add("running");

  const info = document.createElement("span");
  const parts = [];
  if (thread.updatedAt) parts.push(relativeTime(thread.updatedAt));
  if (thread.cwd) parts.push(baseName(thread.cwd));
  info.textContent = parts.join("  ·  ") || "—";

  meta.appendChild(dot);
  meta.appendChild(info);
  card.appendChild(title);
  card.appendChild(meta);
  return card;
}

async function openThread(thread) {
  state.conversationId = thread.conversationId;
  els.currentTitle.textContent = thread.title || thread.conversationId;
  els.messageInput.disabled = false;
  els.send.disabled = false;
  els.interrupt.disabled = false;

  for (const card of els.threads.querySelectorAll(".thread-card")) {
    const isActive = card.querySelector(".thread-title").textContent === els.currentTitle.textContent;
    card.classList.toggle("active", isActive);
  }
  els.messages.innerHTML = "";
  state.pendingMessages = [];
  connectEvents();
  await loadHistory();

  // Close sidebar on mobile after selection
  if (window.innerWidth <= 720) els.sidebar.classList.remove("open");
}

/* ── History ── */

async function loadHistory() {
  try {
    setStatus("");
    const history = await api(`/history/${encodeURIComponent(state.conversationId)}`);
    renderHistory(history.state);
  } catch (error) {
    setStatus(error.message);
  }
}

function renderHistory(stateData) {
  els.messages.innerHTML = "";
  const turns = stateData && Array.isArray(stateData.turns) ? stateData.turns : [];
  if (turns.length === 0) {
    els.messages.innerHTML = '<div class="empty-state">暂无历史消息</div>';
    return;
  }
  for (const turn of turns) {
    for (const item of turn.items || []) {
      appendItem(item);
    }
  }
  prunePendingMessages(stateData);
  for (const p of state.pendingMessages) appendPendingMessage(p);
  scrollBottom();
}

function appendItem(item) {
  if (item.type === "userMessage") {
    appendMessage("user", (item.content || []).map(c => c.text || "").join("\n"));
  } else if (item.type === "agentMessage") {
    appendMessage("assistant", item.text || "");
  }
}

/* ── Send / Stop ── */

async function sendMessage(event) {
  event.preventDefault();
  const message = els.messageInput.value.trim();
  if (!state.conversationId || !message) return;
  els.send.disabled = true;
  const pending = addPendingMessage(message);
  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
  setStatus("");
  try {
    const result = await api("/send", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId, message })
    });
    if (result.ok !== true) throw new Error(result.error || "发送失败");
  } catch (error) {
    removePendingMessage(pending.id);
    setStatus(error.message);
  } finally {
    els.send.disabled = false;
  }
}

async function interruptTurn() {
  if (!state.conversationId) return;
  try {
    await api("/interrupt", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId })
    });
    setStatus("已中断");
  } catch (error) {
    setStatus(error.message);
  }
}

/* ── Events ── */

function connectEvents() {
  if (state.socket) state.socket.close();
  const wsUrl = `${state.baseUrl.replace(/^http/, "ws")}/events?conversationId=${encodeURIComponent(state.conversationId)}`;
  state.socket = new WebSocket(wsUrl);
  state.socket.onmessage = (event) => handleEvent(JSON.parse(event.data));
  state.socket.onclose = () => setStatus("");
  state.socket.onerror = () => setStatus("");
}

function handleEvent(event) {
  if (event.type === "message") {
    const p = event.payload || {};
    if (p.role === "user" && hasPendingText(p.text)) return;
    if (p.text) appendMessage(p.role || "event", p.text);
  } else if (event.type === "thread_state_changed") {
    if (event.payload && event.payload.state) renderHistory(event.payload.state);
  }
}

/* ── Messages ── */

function appendMessage(role, text) {
  if (!text) return;
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  scrollBottom();
}

function addPendingMessage(text) {
  const pending = { id: `p-${Date.now()}-${Math.random().toString(16).slice(2)}`, text };
  state.pendingMessages.push(pending);
  const div = document.createElement("div");
  div.className = "msg user pending";
  div.dataset.pendingId = pending.id;
  div.textContent = pending.text;
  els.messages.appendChild(div);
  scrollBottom();
  return pending;
}

function removePendingMessage(id) {
  state.pendingMessages = state.pendingMessages.filter(m => m.id !== id);
  const el = els.messages.querySelector(`[data-pending-id="${id}"]`);
  if (el) el.remove();
}

function prunePendingMessages(stateData) {
  state.pendingMessages = state.pendingMessages.filter(p => !historyHasUserText(stateData, p.text));
}

function historyHasUserText(stateData, text) {
  for (const turn of (stateData && stateData.turns || [])) {
    for (const item of turn.items || []) {
      if (item.type !== "userMessage") continue;
      if ((item.content || []).map(c => c.text || "").join("\n") === text) return true;
    }
  }
  return false;
}

function hasPendingText(text) {
  return state.pendingMessages.some(p => p.text === text);
}

/* ── Helpers ── */

function relativeTime(value) {
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 172800e3) return "昨天";
  return `${Math.floor(diff / 86400e3)} 天前`;
}

function baseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function autoResize() {
  const el = els.messageInput;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function scrollBottom() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}
