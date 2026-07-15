"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ControlPlaneClient } = require("./control-plane-client");
const {
  errorMessage,
  findThreadByPrefix,
  formatThread,
  historyText,
  latestAssistantMessageForTurn,
  splitMessage,
  turnsFromState
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
    this.stateFile = options.stateFile || "";

    this.currentConversationId = "";
    this.currentThread = null;
    this.lastCompletedAssistantMessage = "";
    this.lastCompletedTurnId = "";
    this.awaitingTurnStart = false;
    this.activeTurnId = "";
    this.pendingApprovalId = "";
    this.pendingApprovalCommand = "";
    this.socket = null;
    this.socketGeneration = 0;
    this.reconnectTimer = null;
    this.restoreState();
  }

  async handleText(text) {
    const input = String(text || "").trim();
    if (!input) return;

    try {
      if (input.startsWith("/")) {
        return await this.handleCommand(input);
      }
      return await this.sendUserMessage(input);
    } catch (error) {
      await this.reply(this.toUserError(error));
      return { ok: false, sent: false, error };
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
    if (this.awaitingTurnStart || this.activeTurnId) {
      await this.reply("当前任务仍在运行，请先使用 /stop 中断后再切换会话");
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
      this.logger.info && this.logger.info({
        conversationId: this.currentConversationId,
        status: "warm_started"
      });
      let warmResult;
      try {
        warmResult = await this.client.warm(this.currentConversationId);
      } catch (error) {
        const message = errorMessage(error);
        if (!/Desktop 当前离线|fetch failed|ECONNREFUSED|ECONNRESET/i.test(message)) throw error;
        warmResult = { ok: false, timeout: true, error: message };
      }
      this.logger.info && this.logger.info({
        conversationId: this.currentConversationId,
        status: warmResult.ok && warmResult.sendable
          ? "warm_completed"
          : (warmResult.timeout ? "warm_timeout" : "warm_failed"),
        error: warmResult.ok ? undefined : warmResult.error
      });
      if (!warmResult.ok && !warmResult.timeout) {
        await this.reply("会话打开失败，请先在 Desktop 中手动打开此会话");
        return;
      }
      // Refresh thread list to get updated sendable status
      const refreshed = await this.client.listThreads();
      this.currentThread = refreshed.find(
        (t) => (t.conversationId || t.id) === this.currentConversationId
      ) || thread;
      if (!this.currentThread.sendable) {
        this.currentThread = {
          ...this.currentThread,
          sendable: false,
          warmUnconfirmed: true
        };
      }
    }

    this.clearActiveTurnState();
    this.connectEvents();
    this.saveState();
    const rawTitle = (this.currentThread && this.currentThread.title) || this.currentConversationId;
    const short = String(rawTitle).replace(/\r?\n/g, " ");
    const display = short.length > 40 ? short.slice(0, 40) + "…" : short;
    if (!this.currentThread.sendable) {
      this.logger.warn && this.logger.warn({
        conversationId: this.currentConversationId,
        status: "switch_unconfirmed"
      });
      await this.reply([
        "会话切换未确认：",
        display,
        "",
        "Desktop 尚未返回可发送状态，请稍后重试 /q " + prefix
      ].join("\n"));
      return;
    }
    this.logger.info && this.logger.info({
      conversationId: this.currentConversationId,
      status: "switch_completed"
    });
    await this.reply([
      "会话切换完成：",
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
    this.clearActiveTurnState();
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
    this.pendingApprovalCommand = "";
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
    if (!await this.requireConversation()) return { ok: false, sent: false, reason: "no_conversation" };
    this.awaitingTurnStart = true;
    this.activeTurnId = "";
    try {
      await this.client.send(this.currentConversationId, message);
    } catch (error) {
      this.clearActiveTurnState();
      throw error;
    }
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
    return { ok: true, sent: true };
  }

  connectEvents() {
    if (!this.currentConversationId) return;
    const generation = ++this.socketGeneration;
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
      message: (event) => {
        this.handleEvent(event).catch((error) => this.handleEventError(event, error));
      },
      error: (error) => this.logger.warn && this.logger.warn(errorMessage(error)),
      close: () => {
        if (generation !== this.socketGeneration) return;
        this.socket = null;
        this.scheduleReconnect(conversationId);
      }
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

    if (event.type === "turn_started") {
      this.handleTurnStarted(event.payload || event);
    } else if (event.type === "turn_completed") {
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
    const raw = payload.raw || event.raw || {};
    const params = raw.params || {};
    const command = raw.command
      || params.command
      || params.cmd
      || (Array.isArray(params.commandActions)
        ? params.commandActions.map((action) => action && (action.command || action.cmd)).filter(Boolean).join(" && ")
        : "");
    if (this.pendingApprovalId === approvalId && this.pendingApprovalCommand === command) return;
    this.pendingApprovalId = approvalId;
    this.pendingApprovalCommand = command;
    await this.reply([
      "需要审批：",
      command || "Desktop 请求确认一项命令操作",
      "",
      "回复 /y 批准，/n 拒绝"
    ].join("\n"));
  }

  async reconcileCurrentTurnState() {
    if (!this.currentConversationId) return { checked: false };
    try {
      const history = await this.client.loadHistory(this.currentConversationId);
      const state = history.state || history;
      const latest = latestTurn(state);
      const status = latest && latest.status ? String(latest.status) : "";
      if (!latest) {
        return { checked: true, running: true, status };
      }
      if (isRunningTurnStatus(status)) {
        this.handleTurnStarted({ turnId: latest.turnId || "", reason: "reconcile" });
        return { checked: true, running: true, status };
      }
      if (status === "completed") {
        const turnId = String(latest.turnId || "");
        await this.handleTurnCompleted({
          conversationId: this.currentConversationId,
          turnId,
          reason: "reconcile"
        });
        return { checked: true, running: false, status };
      }
      if (isInterruptedTurnStatus(status)) {
        await this.handleTurnInterrupted({
          conversationId: this.currentConversationId,
          turnId: latest.turnId || "",
          reason: "reconcile",
          status
        });
      }
      return { checked: true, running: false, status };
    } catch (error) {
      this.logger.warn && this.logger.warn("Failed to reconcile turn state", errorMessage(error));
      return { checked: false, error };
    }
  }

  async handleEventError(event, error) {
    this.logger.warn && this.logger.warn({
      conversationId: this.currentConversationId,
      turnId: event && event.payload && event.payload.turnId,
      status: "event_handler_failed",
      error: errorMessage(error)
    });
    const payload = (event && event.payload) || event || {};
    const turnId = String(payload.turnId || "");
    if (turnId && this.isActiveTurn(turnId)) {
      await this.settleActiveTurn({
        conversationId: this.currentConversationId,
        turnId,
        reason: "event_handler_failed",
        status: "completed"
      });
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
    const payloadTurnId = String(payload.turnId || "");
    if (!this.isActiveTurn(payloadTurnId)) return;
    let replyAttempted = false;

    try {
      const history = await this.client.loadHistory(this.currentConversationId);
      // follower-core returns {state: {turns: [...]}}, daily_server returns {items: [...]}
      const state = history.state || history;
      const latest = latestAssistantMessageForTurn(state, payloadTurnId);
      if (!latest || !latest.text) {
        this.logger.info && this.logger.info({
          conversationId: this.currentConversationId,
          turnId: payloadTurnId,
          phase: "",
          length: 0,
          status: "assistant_message_missing"
        });
        return;
      }
      const completionTurnId = latest.turnId || payloadTurnId;
      if (completionTurnId && completionTurnId === this.lastCompletedTurnId) return;

      replyAttempted = true;
      await this.reply(latest.text);
      this.lastCompletedAssistantMessage = latest.text;
      if (completionTurnId) this.lastCompletedTurnId = completionTurnId;
      this.logger.info && this.logger.info({
        conversationId: this.currentConversationId,
        turnId: completionTurnId,
        phase: latest.phase || "",
        length: String(latest.text).length,
        status: "reply_sent"
      });
      await this.settleActiveTurn({
        conversationId: this.currentConversationId,
        turnId: payloadTurnId,
        reason: payload.reason || "completed",
        status: "completed"
      });
    } catch (e) {
      this.logger.warn && this.logger.warn({
        conversationId: this.currentConversationId,
        turnId: payloadTurnId,
        phase: "",
        length: 0,
        status: replyAttempted ? "reply_failed" : "history_load_failed",
        error: errorMessage(e)
      });
      if (!replyAttempted) {
        try {
          await this.reply(this.toUserError(e));
        } catch (replyError) {
          this.logger.warn && this.logger.warn({
            conversationId: this.currentConversationId,
            turnId: payloadTurnId,
            status: "error_notice_failed",
            error: errorMessage(replyError)
          });
        }
      } else {
        await this.settleActiveTurn({
          conversationId: this.currentConversationId,
          turnId: payloadTurnId,
          reason: "reply_failed",
          status: "completed"
        });
      }
    }
  }

  async handleTurnInterrupted(payload) {
    const payloadTurnId = String(payload.turnId || "");
    if (!this.isActiveTurn(payloadTurnId)) return;
    await this.settleActiveTurn({
      conversationId: this.currentConversationId,
      turnId: payloadTurnId,
      reason: payload.reason || "interrupted",
      status: payload.status || "interrupted"
    });
  }

  handleTurnStarted(payload) {
    const turnId = String(payload.turnId || "");
    if (!turnId) return false;
    if (this.activeTurnId && !this.awaitingTurnStart && this.activeTurnId !== turnId) return false;
    this.activeTurnId = turnId;
    this.awaitingTurnStart = false;
    return true;
  }

  isActiveTurn(turnId) {
    return !this.awaitingTurnStart
      && Boolean(this.activeTurnId)
      && String(turnId || "") === this.activeTurnId;
  }

  clearActiveTurnState() {
    this.awaitingTurnStart = false;
    this.activeTurnId = "";
  }

  async settleActiveTurn(event) {
    this.clearActiveTurnState();
    if (this.onTurnSettled) await this.onTurnSettled(event);
  }

  async requireConversation() {
    if (this.currentConversationId) return true;
    await this.reply("请先使用 /q <序号> 或 /ls 查看可用会话");
    return false;
  }

  restoreState() {
    if (!this.stateFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const conversationId = data.currentConversationId || "";
      if (!conversationId) return;
      this.currentConversationId = conversationId;
      this.currentThread = data.currentThread || { conversationId, id: conversationId };
      this.connectEvents();
    } catch {
      // No persisted selection yet.
    }
  }

  saveState() {
    if (!this.stateFile || !this.currentConversationId) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        currentConversationId: this.currentConversationId,
        currentThread: this.currentThread || null,
        savedAt: new Date().toISOString()
      }, null, 2), "utf8");
    } catch (error) {
      this.logger.warn && this.logger.warn("Failed to save wxbot state", errorMessage(error));
    }
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
  const turns = turnsFromState(state);
  return turns.length ? turns[turns.length - 1] : null;
}

function isRunningTurnStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "running" || normalized === "inprogress" || normalized === "in_progress";
}

function isInterruptedTurnStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "interrupted"
    || normalized === "canceled"
    || normalized === "cancelled"
    || normalized === "aborted"
    || normalized === "stopped"
    || normalized === "failed"
    || normalized === "error";
}

function createWxBotAdapter(options) {
  return new WxBotAdapter(options);
}

module.exports = { WxBotAdapter, createWxBotAdapter };
