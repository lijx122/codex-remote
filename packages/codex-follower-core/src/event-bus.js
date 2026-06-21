"use strict";

const { EventEmitter } = require("node:events");

class CodexFollowerEventBus extends EventEmitter {
  publish(event) {
    if (event.type !== "error" || this.listenerCount("error") > 0) {
      this.emit(event.type, event);
    }
    this.emit("*", event);
  }
}

module.exports = { CodexFollowerEventBus };
