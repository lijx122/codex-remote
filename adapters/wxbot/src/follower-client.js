"use strict";

const { createCodexFollower } = require("../../../packages/codex-follower-core/src");

class FollowerCoreClient {
  constructor(options = {}) {
    this.core = createCodexFollower(options.coreOptions || {});
    this.connected = false;
  }

  async _ensureConnected() {
    if (!this.connected) {
      await this.core.connect();
      this.connected = true;
    }
  }

  async listThreads() {
    await this._ensureConnected();
    const threads = this.core.listThreads();
    return threads.map(t => ({
      conversationId: t.id,
      id: t.id,
      title: t.title || t.id,
      updatedAt: t.updatedAt || null
    }));
  }

  async loadHistory(conversationId) {
    await this._ensureConnected();
    return this.core.loadHistory(conversationId);
  }

  async send(conversationId, message) {
    await this._ensureConnected();
    return this.core.sendMessage(conversationId, message);
  }

  async interrupt(conversationId) {
    await this._ensureConnected();
    return this.core.interrupt(conversationId);
  }

  async approve(conversationId, approvalId, decision) {
    await this._ensureConnected();
    const d = decision === true || decision === "allow" ? "allow" : "deny";
    return this.core.approve(conversationId, approvalId, d);
  }

  connectEvents(conversationId, handlers = {}) {
    const bus = this.core.subscribeEvents(conversationId);

    bus.on("*", (event) => {
      if (handlers.message) {
        handlers.message({
          type: event.type,
          conversationId: event.conversationId,
          payload: event
        });
      }
    });

    return {
      close() {
        if (bus.unsubscribe) bus.unsubscribe();
      }
    };
  }
}

module.exports = { FollowerCoreClient };
