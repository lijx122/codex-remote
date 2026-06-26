"use strict";

const state = {
  baseUrl: localStorage.getItem("codexControlPlaneUrl") || defaultBaseUrl(),
  conversationId: "",
  socket: null,
  pendingMessages: [],
  collapsedSections: loadJson("codexCollapsedSections", {}),
  sidebarWidth: Number(localStorage.getItem("codexSidebarWidth")) || 300,
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
  resizeHandle: document.getElementById("resizeHandle"),
  app: document.getElementById("app"),
};

// ── Init ──

applySidebarWidth();
els.controlPlaneUrl.value = state.baseUrl.replace(/^https?:\/\//, "");
els.controlPlaneUrl.addEventListener("change", saveBaseUrl);
els.refreshThreads.addEventListener("click", loadThreads);
els.composer.addEventListener("submit", sendMessage);
els.interrupt.addEventListener("click", interruptTurn);
els.messageInput.addEventListener("input", autoResize);
els.sidebarToggle.addEventListener("click", () => els.sidebar.classList.toggle("open"));
initResize();

loadThreads();
checkWxStatus();
setInterval(checkWxStatus, 5000);

/* ── WeChat QR ── */

const wxQrSection = document.getElementById("wxQrSection");
const wxQrContainer = document.getElementById("wxQrContainer");
const wxQrClose = document.getElementById("wxQrClose");

wxQrClose.addEventListener("click", () => wxQrSection.classList.add("hidden"));

async function checkWxStatus() {
  try {
    const data = await api("/api/wx/status");
    if (data.status === "logged_in") {
      wxQrSection.classList.add("hidden");
      return;
    }
    if (data.qrcodeUrl) {
      wxQrSection.classList.remove("hidden");
      wxQrContainer.innerHTML = `<img src="${esc(data.qrcodeUrl)}" alt="微信二维码" class="wx-qr-img" onerror="this.alt='QR 加载失败，请查看终端'"/>`;
    }
  } catch {
    // Status endpoint unavailable — skip
  }
}

/* ── API ── */

function defaultBaseUrl() {
  return (location.protocol === "http:" || location.protocol === "https:")
    ? `${location.protocol}//${location.hostname}:8787`
    : "http://127.0.0.1:8787";
}

function saveBaseUrl() {
  const raw = els.controlPlaneUrl.value.trim();
  state.baseUrl = raw.startsWith("http") ? raw.replace(/\/$/, "") : `http://${raw.replace(/\/$/, "")}`;
  localStorage.setItem("codexControlPlaneUrl", state.baseUrl);
  setStatus("");
  loadThreads();
}

async function api(path, options = {}) {
  const res = await fetch(`${state.baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/* ── Thread list with grouping ── */

async function loadThreads() {
  try {
    setStatus("");
    const threads = await api("/threads");
    els.threads.innerHTML = "";
    if (threads.length === 0) {
      els.threads.innerHTML = '<div class="empty-state">暂无会话</div>';
      return;
    }
    renderGroupedThreads(threads);
  } catch (error) {
    setStatus(error.message);
  }
}

function renderGroupedThreads(threads) {
  const groups = groupByWorkspace(threads);
  const order = Object.keys(groups).sort((a, b) => {
    if (a === "无工作目录") return 1;
    if (b === "无工作目录") return -1;
    const ma = maxUpdated(groups[a]), mb = maxUpdated(groups[b]);
    return (mb || 0) - (ma || 0);
  });

  for (const name of order) {
    els.threads.appendChild(buildSection(name, groups[name]));
  }
}

function groupByWorkspace(threads) {
  const groups = Object.create(null);
  for (const t of threads) {
    const ws = workspaceLabel(t.cwd);
    (groups[ws] || (groups[ws] = [])).push(t);
  }
  // Sort threads within each group by updatedAt desc
  for (const list of Object.values(groups)) {
    list.sort((a, b) => cmpDesc(a.updatedAt, b.updatedAt));
  }
  return groups;
}

function workspaceLabel(cwd) {
  if (!cwd) return "无工作目录";
  const s = String(cwd).replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function maxUpdated(list) {
  let max = 0;
  for (const t of list) {
    const v = Date.parse(t.updatedAt);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function cmpDesc(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  return (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);
}

/* ── Section DOM ── */

function buildSection(name, threads) {
  const key = `ws-${name}`;
  const collapsed = state.collapsedSections[key] === true;

  const section = document.createElement("div");
  section.className = "ws-section" + (collapsed ? " collapsed" : "");

  // Header
  const header = document.createElement("div");
  header.className = "ws-header";
  header.title = threads[0]?.cwd || name;
  header.innerHTML =
    `<span class="ws-chevron"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l5 4-5 4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` +
    `<span class="ws-name">${esc(name)}</span>` +
    `<span class="ws-count">${threads.length}</span>`;
  header.addEventListener("click", () => toggleSection(section, key));

  // Items
  const items = document.createElement("div");
  items.className = "ws-items";

  for (const t of threads) {
    items.appendChild(buildThreadCard(t));
  }

  section.appendChild(header);
  section.appendChild(items);
  return section;
}

function toggleSection(section, key) {
  const collapsed = section.classList.toggle("collapsed");
  state.collapsedSections[key] = collapsed;
  saveJson("codexCollapsedSections", state.collapsedSections);
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
  info.textContent = thread.updatedAt ? relativeTime(thread.updatedAt) : "—";

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
    card.classList.toggle("active",
      card.querySelector(".thread-title").textContent === els.currentTitle.textContent);
  }
  els.messages.innerHTML = "";
  state.pendingMessages = [];
  connectEvents();
  await loadHistory();
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
  const turns = (stateData && stateData.turns) || [];
  if (!turns.length) { els.messages.innerHTML = '<div class="empty-state">暂无历史消息</div>'; return; }
  for (const turn of turns) {
    for (const item of turn.items || []) appendItem(item);
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
  const msg = els.messageInput.value.trim();
  if (!state.conversationId || !msg) return;
  els.send.disabled = true;
  const pending = addPendingMessage(msg);
  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
  setStatus("");
  try {
    const result = await api("/send", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId, message: msg })
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
  state.socket.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
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
  const p = { id: `p-${Date.now()}-${Math.random().toString(16).slice(2)}`, text };
  state.pendingMessages.push(p);
  const div = document.createElement("div");
  div.className = "msg user pending";
  div.dataset.pendingId = p.id;
  div.textContent = p.text;
  els.messages.appendChild(div);
  scrollBottom();
  return p;
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

/* ── Resize ── */

function initResize() {
  let dragging = false;
  let startX = 0, startW = 0;

  els.resizeHandle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = state.sidebarWidth;
    els.resizeHandle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(220, Math.min(500, startW + (e.clientX - startX)));
    state.sidebarWidth = w;
    applySidebarWidth();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    els.resizeHandle.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("codexSidebarWidth", state.sidebarWidth);
  });
}

function applySidebarWidth() {
  els.app.style.setProperty("--sidebar-w", state.sidebarWidth + "px");
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

function autoResize() {
  const el = els.messageInput;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function scrollBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
