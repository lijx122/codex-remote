"use strict";

const state = {
  baseUrl: localStorage.getItem("codexControlPlaneUrl") || defaultBaseUrl(),
  conversationId: "",
  socket: null,
  approval: null,
  pendingMessages: []
};

const els = {
  controlPlaneUrl: document.getElementById("controlPlaneUrl"),
  saveUrl: document.getElementById("saveUrl"),
  refreshThreads: document.getElementById("refreshThreads"),
  threads: document.getElementById("threads"),
  currentTitle: document.getElementById("currentTitle"),
  status: document.getElementById("status"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  send: document.getElementById("send"),
  interrupt: document.getElementById("interrupt"),
  approvalBox: document.getElementById("approvalBox"),
  approvalText: document.getElementById("approvalText"),
  approveYes: document.getElementById("approveYes"),
  approveNo: document.getElementById("approveNo")
};

els.controlPlaneUrl.value = state.baseUrl;
els.saveUrl.addEventListener("click", saveBaseUrl);
els.refreshThreads.addEventListener("click", loadThreads);
els.composer.addEventListener("submit", sendMessage);
els.interrupt.addEventListener("click", interruptTurn);
els.approveYes.addEventListener("click", () => approve(true));
els.approveNo.addEventListener("click", () => approve(false));

loadThreads();

function defaultBaseUrl() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    return `${location.protocol}//${location.hostname}:8787`;
  }
  return "http://127.0.0.1:8787";
}

function saveBaseUrl() {
  state.baseUrl = els.controlPlaneUrl.value.replace(/\/$/, "");
  localStorage.setItem("codexControlPlaneUrl", state.baseUrl);
  setStatus("Control Plane 已保存");
  loadThreads();
}

async function api(path, options = {}) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function loadThreads() {
  try {
    setStatus("加载会话...");
    const threads = await api("/threads");
    els.threads.innerHTML = "";
    for (const thread of threads) {
      const button = document.createElement("button");
      button.className = "thread";
      button.textContent = thread.title || thread.conversationId;
      button.addEventListener("click", () => openThread(thread));
      els.threads.appendChild(button);
    }
    setStatus(threads.length ? `会话 ${threads.length} 个` : "暂无会话，先在 Desktop 打开一个会话");
  } catch (error) {
    setStatus(error.message);
  }
}

async function openThread(thread) {
  state.conversationId = thread.conversationId;
  els.currentTitle.textContent = thread.title || thread.conversationId;
  for (const item of els.threads.querySelectorAll(".thread")) {
    item.classList.toggle("active", item.textContent === els.currentTitle.textContent);
  }
  els.messages.innerHTML = "";
  state.pendingMessages = [];
  connectEvents();
  await loadHistory();
}

async function loadHistory() {
  try {
    setStatus("加载历史...");
    const history = await api(`/history/${encodeURIComponent(state.conversationId)}`);
    renderHistory(history.state);
    setStatus(`revision ${history.revision || ""}`);
  } catch (error) {
    setStatus(error.message);
  }
}

function renderHistory(stateData) {
  els.messages.innerHTML = "";
  const turns = stateData && Array.isArray(stateData.turns) ? stateData.turns : [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      appendItem(item);
    }
  }
  prunePendingMessages(stateData);
  for (const pending of state.pendingMessages) {
    appendPendingMessage(pending);
  }
  scrollBottom();
}

function appendItem(item) {
  if (item.type === "userMessage") {
    const text = (item.content || []).map((part) => part.text || "").join("\n");
    appendMessage("user", text);
  } else if (item.type === "agentMessage") {
    appendMessage("assistant", item.text || "");
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const message = els.messageInput.value.trim();
  if (!state.conversationId || !message) return;
  els.send.disabled = true;
  const pending = addPendingMessage(message);
  els.messageInput.value = "";
  setStatus("发送中...");
  try {
    const result = await api("/send", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId, message })
    });
    if (result.ok !== true) {
      throw new Error(`发送失败: ${JSON.stringify(result)}`);
    }
    setStatus("已发送 ok=true");
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

async function approve(decision) {
  if (!state.conversationId || !state.approval) return;
  try {
    await api("/approve", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        approvalId: state.approval.approvalId,
        decision
      })
    });
    els.approvalBox.hidden = true;
    state.approval = null;
    setStatus(decision ? "已批准" : "已拒绝");
  } catch (error) {
    setStatus(error.message);
  }
}

function connectEvents() {
  if (state.socket) {
    state.socket.close();
  }
  const wsUrl = `${state.baseUrl.replace(/^http/, "ws")}/events?conversationId=${encodeURIComponent(state.conversationId)}`;
  state.socket = new WebSocket(wsUrl);
  state.socket.onopen = () => setStatus("事件已连接");
  state.socket.onerror = () => setStatus("事件连接错误");
  state.socket.onmessage = (event) => handleEvent(JSON.parse(event.data));
  state.socket.onclose = () => setStatus("事件已断开");
}

function handleEvent(event) {
  if (event.type === "message") {
    const payload = event.payload || {};
    if (payload.role === "user" && hasPendingText(payload.text)) return;
    if (payload.text) appendMessage(payload.role || "event", payload.text);
  } else if (event.type === "thread_state_changed") {
    if (event.payload && event.payload.state) {
      renderHistory(event.payload.state);
    }
  } else if (event.type === "turn_completed") {
    appendMessage("event", "turn completed");
  } else if (event.type === "approval_request") {
    state.approval = event.payload || {};
    els.approvalText.textContent = `Approval: ${state.approval.approvalId || ""}`;
    els.approvalBox.hidden = false;
  } else if (event.type === "error") {
    setStatus((event.payload && event.payload.message) || "error");
  }
}

function appendMessage(role, text) {
  if (!text) return;
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  scrollBottom();
}

function addPendingMessage(text) {
  const pending = {
    id: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text
  };
  state.pendingMessages.push(pending);
  appendPendingMessage(pending);
  return pending;
}

function appendPendingMessage(pending) {
  if (!pending || !pending.text) return;
  const div = document.createElement("div");
  div.className = "msg user pending";
  div.dataset.pendingId = pending.id;
  div.textContent = pending.text;
  els.messages.appendChild(div);
  scrollBottom();
}

function removePendingMessage(id) {
  state.pendingMessages = state.pendingMessages.filter((message) => message.id !== id);
  const el = els.messages.querySelector(`[data-pending-id="${id}"]`);
  if (el) el.remove();
}

function prunePendingMessages(stateData) {
  state.pendingMessages = state.pendingMessages.filter((pending) => (
    !historyHasUserText(stateData, pending.text)
  ));
}

function historyHasUserText(stateData, text) {
  const turns = stateData && Array.isArray(stateData.turns) ? stateData.turns : [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type !== "userMessage") continue;
      const itemText = (item.content || []).map((part) => part.text || "").join("\n");
      if (itemText === text) return true;
    }
  }
  return false;
}

function hasPendingText(text) {
  return Boolean(text && state.pendingMessages.some((pending) => pending.text === text));
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}
