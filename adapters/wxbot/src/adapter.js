"use strict";

const { ControlPlaneClient } = require("./control-plane-client");
const {
  errorMessage,
  findThreadByPrefix,
  formatThread,
  historyText,
  latestAssistantMessage,
  splitMessage
} = require("./message-utils");

class WxBotAdapter {
  constructor(options = {}) {
    if (typeof options.sendText !== "function") {
      throw new Error("sendText(text) is required");
    }
    this.client = options.client || new ControlPlaneClient({ baseUrl: options.controlPlaneUrl });
    this.sendText = options.sendText;
    this.sendFile = typeof options.sendFile === "function" ? options.sendFile : null;
    this.maxMessageLength = options.maxMessageLength || 1500;
    this.maxThreads = options.maxThreads || 20;
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || console;
    this.onTurnSettled = typeof options.onTurnSettled === "function" ? options.onTurnSettled : null;

    this.currentConversationId = "";
    this.currentThread = null;
    this.lastCompletedAssistantMessage = "";
    this.lastCompletedTurnId = "";
    this.pendingApprovalId = "";
    this.socket = null;
    this.reconnectTimer = null;
  }

  async handleText(text) {
    const input = String(text || "").trim();
    if (!input) return;

    try {
      if (input.startsWith("/")) {
        await this.handleCommand(input);
        return;
      }
      await this.sendUserMessage(input);
    } catch (error) {
      await this.reply(this.toUserError(error));
    }
  }

  async handleCommand(input) {
    const [command, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (command === "/ls" || command === "/list") return this.commandList(arg);
    if (command === "/q") return this.commandSwitch(arg);
    if (command === "/where") return this.commandWhere();
    if (command === "/stop") return this.commandStop();
    if (command === "/history") return this.commandHistory();
    if (command === "/help") return this.commandHelp();
    if (command === "/sendfile") return this.commandSendFile(input.slice(command.length).trim());
    if (command === "/approve") return this.commandApprove(arg);
    if (command === "/y") return this.commandApprove("yes");
    if (command === "/n") return this.commandApprove("no");

    await this.reply("未知命令，发送 /help 查看可用命令");
  }

  async commandList(arg) {
    const threads = await this.client.listThreads();
    const limit = arg === "all" ? threads.length : (parseInt(arg, 10) || this.maxThreads);
    const recent = threads.slice(0, limit);
    if (recent.length === 0) {
      await this.reply("暂无会话，请先在 Desktop 打开或创建一个会话");
      return;
    }
    const lines = recent.map((thread, index) => formatThread(thread, index, this.now())).join("\n\n");
    const sendableCount = recent.filter(t => t.sendable).length;
    await this.reply(`${lines}\n\n● 已就绪(${sendableCount})  ○ 切换时自动打开`);
  }

  async commandSwitch(prefix) {
    if (!prefix) {
      await this.reply("用法：/q <序号> 或 /q <id前缀>");
      return;
    }
    const allThreads = await this.client.listThreads();
    const thread = findThreadByPrefix(allThreads, prefix);
    if (!thread) {
      await this.reply("会话不存在，请使用 /ls 查看");
      return;
    }

    this.currentConversationId = thread.conversationId || thread.id;
    this.currentThread = thread;

    // Auto-warm if not loaded in Desktop
    if (!thread.sendable) {
      await this.reply("正在打开会话，请稍候...");
      const warmResult = await this.client.warm(this.currentConversationId);
      if (!warmResult.ok) {
        await this.reply("会话打开失败，请先在 Desktop 中手动打开此会话");
        return;
      }
      // Refresh thread list to get updated sendable status
      const refreshed = await this.client.listThreads();
      this.currentThread = refreshed.find(
        (t) => (t.conversationId || t.id) === this.currentConversationId
      ) || thread;
      if (!this.currentThread.sendable) {
        await this.reply("会话正在打开，但暂时还不能发送。请稍后重试 /q。");
        return;
      }
    }

    this.connectEvents();
    const rawTitle = (this.currentThread && this.currentThread.title) || this.currentConversationId;
    const short = String(rawTitle).replace(/\r?\n/g, " ");
    const display = short.length > 40 ? short.slice(0, 40) + "…" : short;
    await this.reply([
      "当前会话：",
      this.currentConversationId.slice(0, 20) + "...",
      "",
      "标题：" + display
    ].join("\n"));
  }

  async commandWhere() {
    if (!this.currentConversationId) {
      await this.reply("请先使用 /q 或 /new");
      return;
    }
    const rawTitle = (this.currentThread && this.currentThread.title) || this.currentConversationId;
    const short = String(rawTitle).replace(/\r?\n/g, " ");
    const display = short.length > 40 ? short.slice(0, 40) + "…" : short;
    await this.reply([
      "当前会话：",
      this.currentConversationId,
      "",
      "标题：",
      display,
      "",
      "最后活动：",
      formatLastActive(this.currentThread, this.now())
    ].join("\n"));
  }

  async commandStop() {
    if (!await this.requireConversation()) return;
    await this.client.interrupt(this.currentConversationId);
    await this.reply("已发送中断请求");
  }

  async commandApprove(arg) {
    if (!this.pendingApprovalId) {
      await this.reply("当前没有待审批请求");
      return;
    }
    const normalized = String(arg || "").trim().toLowerCase();
    const allow = normalized === "yes" || normalized === "y" || normalized === "allow" || normalized === "true";
    const deny = normalized === "no" || normalized === "n" || normalized === "deny" || normalized === "false";
    if (!allow && !deny) {
      await this.reply("用法：/approve yes 或 /approve no");
      return;
    }
    const approvalId = this.pendingApprovalId;
    this.pendingApprovalId = "";
    await this.client.approve(this.currentConversationId, approvalId, allow);
    await this.reply(allow ? "已批准" : "已拒绝");
  }

  async commandHistory() {
    if (!await this.requireConversation()) return;
    try {
      const history = await this.client.loadHistory(this.currentConversationId);
      const state = history.state || history;
      await this.reply(historyText(state, 20));
    } catch (e) {
      await this.reply(`获取历史失败：${e.message}`);
    }
  }

  async commandHelp() {
    await this.reply([
      "/ls [数量] 查看最近会话（默认20，/ls all 查看全部）",
      "/q <序号>  切换会话",
      "/where    查看当前会话",
      "/history  查看最近消息",
      "/stop     中断当前任务",
      "/sendfile <路径>  发送本地文件到当前微信",
      "/help     查看帮助",
      "",
      "非 / 开头的消息会发送到当前会话。",
      "新建会话请在 Desktop 中操作（Ctrl+N）。"
    ].join("\n"));
  }

  async sendUserMessage(message) {
    if (!await this.requireConversation()) return;
    await this.client.send(this.currentConversationId, message);
    const rawTitle = (this.currentThread && this.currentThread.title) || this.currentConversationId;
    const short = String(rawTitle).replace(/\r?\n/g, " ");
    const display = short.length > 40 ? short.slice(0, 40) + "…" : short;
    await this.reply([
      "✓ 已提交",
      "",
      "当前会话：",
      display,
      "",
      "状态：",
      "运行中..."
    ].join("\n"));
    this.connectEvents();
  }

  connectEvents() {
    if (!this.currentConversationId) return;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const conversationId = this.currentConversationId;
    this.socket = this.client.connectEvents(conversationId, {
      message: (event) => this.handleEvent(event),
      error: (error) => this.logger.warn && this.logger.warn(errorMessage(error)),
      close: () => this.scheduleReconnect(conversationId)
    });
  }

  scheduleReconnect(conversationId) {
    if (conversationId !== this.currentConversationId || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (conversationId === this.currentConversationId) this.connectEvents();
    }, 2000);
  }

  async handleEvent(event) {
    if (!event || event.conversationId !== this.currentConversationId) return;

    if (event.type === "turn_completed") {
      await this.handleTurnCompleted(event.payload || {});
    } else if (event.type === "turn_interrupted" || event.type === "interrupt") {
      await this.handleTurnInterrupted(event.payload || event);
    } else if (event.type === "approval_request") {
      await this.handleApprovalRequest(event);
    } else if (event.type === "error") {
      await this.reply(`执行失败\n\n错误：\n${(event.payload && event.payload.message) || "未知错误"}`);
    }
  }

  async handleApprovalRequest(event) {
    const payload = event.payload || event;
    const approvalId = event.approvalId || payload.approvalId || payload.id || "";
    if (!approvalId) return;
    this.pendingApprovalId = approvalId;
    const raw = payload.raw || event.raw || {};
    const params = raw.params || {};
    const command = raw.command || params.command || params.cmd || "";
    await this.reply([
      "需要审批：",
      command || JSON.stringify(raw),
      "",
      "回复 /y 批准，/n 拒绝"
    ].join("\n"));
  }

  async reconcileCurrentTurnState() {
    if (!this.currentConversationId || !this.onTurnSettled) return { checked: false };
    try {
      const history = await this.client.loadHistory(this.currentConversationId);
      const state = history.state || history;
      const latest = latestTurn(state);
      const status = latest && latest.status ? String(latest.status) : "";
      if (!latest || isRunningTurnStatus(status)) {
        return { checked: true, running: true, status };
      }
      await this.onTurnSettled({
        conversationId: this.currentConversationId,
        turnId: latest.turnId || "",
        reason: "reconcile",
        status
      });
      return { checked: true, running: false, status };
    } catch (error) {
      this.logger.warn && this.logger.warn("Failed to reconcile turn state", errorMessage(error));
      return { checked: false, error };
    }
  }

  async commandSendFile(arg) {
    if (!arg) {
      await this.reply("用法：/sendfile <本地文件路径>");
      return;
    }
    if (!this.sendFile) {
      await this.reply("当前运行方式不支持发送本地文件");
      return;
    }
    const result = await this.sendFile(arg);
    await this.reply([
      "已发送文件：",
      result.fileName || arg,
      "",
      "大小：",
      formatBytes(result.size)
    ].join("\n"));
  }

  async handleTurnCompleted(payload) {
    const turnId = payload.turnId || "";
    if (turnId && turnId === this.lastCompletedTurnId) return;
    if (turnId) this.lastCompletedTurnId = turnId;

    try {
      const history = await this.client.loadHistory(this.currentConversationId);
      // follower-core returns {state: {turns: [...]}}, daily_server returns {items: [...]}
      const state = history.state || history;
      const latest = latestAssistantMessage(state);
      if (!latest || !latest.text) return;

      this.lastCompletedAssistantMessage = latest.text;
      await this.reply(latest.text);
    } catch (e) {
      this.logger.warn && this.logger.warn("Failed to load history for turn_completed", e);
    } finally {
      if (this.onTurnSettled) {
        await this.onTurnSettled({ conversationId: this.currentConversationId, turnId });
      }
    }
  }

  async handleTurnInterrupted(payload) {
    if (!this.onTurnSettled) return;
    await this.onTurnSettled({
      conversationId: this.currentConversationId,
      turnId: payload.turnId || "",
      reason: "interrupted",
      status: payload.status || "interrupted"
    });
  }

  async requireConversation() {
    if (this.currentConversationId) return true;
    await this.reply("请先使用 /q <序号> 或 /ls 查看可用会话");
    return false;
  }

  async reply(text) {
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.sendText(chunk);
    }
  }

  toUserError(error) {
    const message = errorMessage(error);
    if (/Desktop 当前离线|fetch failed|ECONNREFUSED/i.test(message)) return "Desktop 当前离线";
    if (/no-client-found|not found|未在 Desktop 中打开/i.test(message)) return "会话未在 Desktop 中打开\n请先在 Desktop 中打开此会话，再用 /q 切换";
    return `执行失败\n\n错误：\n${message}`;
  }
}

function formatLastActive(thread, now) {
  if (!thread || !thread.updatedAt) return "未知";
  return require("./message-utils").relativeTime(thread.updatedAt, now);
}

function formatBytes(size) {
  const bytes = Number(size || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function latestTurn(state) {
  const turns = state && Array.isArray(state.turns) ? state.turns : [];
  return turns.length ? turns[turns.length - 1] : null;
}

function isRunningTurnStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "running" || normalized === "inprogress" || normalized === "in_progress";
}

function createWxBotAdapter(options) {
  return new WxBotAdapter(options);
}

module.exports = { WxBotAdapter, createWxBotAdapter };
