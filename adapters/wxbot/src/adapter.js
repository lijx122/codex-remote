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
    this.maxMessageLength = options.maxMessageLength || 1500;
    this.maxThreads = options.maxThreads || 20;
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || console;

    this.currentConversationId = "";
    this.currentThread = null;
    this.lastCompletedAssistantMessage = "";
    this.lastCompletedTurnId = "";
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

    if (command === "/ls" || command === "/list") return this.commandList();
    if (command === "/q") return this.commandSwitch(arg);
    if (command === "/where") return this.commandWhere();
    if (command === "/stop") return this.commandStop();
    if (command === "/history") return this.commandHistory();
    if (command === "/help") return this.commandHelp();

    await this.reply("未知命令，发送 /help 查看可用命令");
  }

  async commandList() {
    const threads = await this.client.listThreads();
    const recent = threads.slice(0, this.maxThreads);
    if (recent.length === 0) {
      await this.reply("暂无会话，请先在 Desktop 打开或创建一个会话");
      return;
    }
    await this.reply(recent.map((thread, index) => formatThread(thread, index, this.now())).join("\n\n"));
  }

  async commandSwitch(prefix) {
    if (!prefix) {
      await this.reply("用法：/q <conversationId前缀>");
      return;
    }
    const threads = await this.client.listThreads();
    const thread = findThreadByPrefix(threads, prefix);
    if (!thread) {
      await this.reply("会话不存在，请使用 /list 查看");
      return;
    }

    this.currentConversationId = thread.conversationId || thread.id;
    this.currentThread = thread;
    this.connectEvents();
    await this.reply([
      "当前会话：",
      this.currentConversationId,
      "",
      "标题：",
      thread.title || this.currentConversationId
    ].join("\n"));
  }

  async commandWhere() {
    if (!this.currentConversationId) {
      await this.reply("请先使用 /q 或 /new");
      return;
    }
    await this.reply([
      "当前会话：",
      this.currentConversationId,
      "",
      "标题：",
      (this.currentThread && this.currentThread.title) || this.currentConversationId,
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
      "/ls       查看最近会话",
      "/q <序号>  切换会话",
      "/where    查看当前会话",
      "/history  查看最近消息",
      "/stop     中断当前任务",
      "/help     查看帮助",
      "",
      "非 / 开头的消息会发送到当前会话。",
      "新建会话请在 Desktop 中操作（Ctrl+N）。"
    ].join("\n"));
  }

  async sendUserMessage(message) {
    if (!await this.requireConversation()) return;
    await this.client.send(this.currentConversationId, message);
    await this.reply([
      "✓ 已提交",
      "",
      "当前会话：",
      (this.currentThread && this.currentThread.title) || this.currentConversationId,
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
    } else if (event.type === "error") {
      await this.reply(`执行失败\n\n错误：\n${(event.payload && event.payload.message) || "未知错误"}`);
    }
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
    }
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
    if (/no-client-found|not found/i.test(message)) return "会话不存在，请使用 /list 查看";
    return `执行失败\n\n错误：\n${message}`;
  }
}

function formatLastActive(thread, now) {
  if (!thread || !thread.updatedAt) return "未知";
  return require("./message-utils").relativeTime(thread.updatedAt, now);
}

function createWxBotAdapter(options) {
  return new WxBotAdapter(options);
}

module.exports = { WxBotAdapter, createWxBotAdapter };
