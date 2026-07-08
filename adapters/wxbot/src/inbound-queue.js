"use strict";

const DEFAULT_TEXT_MERGE_WINDOW_MS = 0;
const DEFAULT_VOICE_MERGE_WINDOW_MS = 0;
const DEFAULT_MEDIA_MERGE_WINDOW_MS = 0;
const DEFAULT_SETTLE_DELAY_MS = 0;
const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PENDING_FILE_LIMIT = 30;

class InboundMessageQueue {
  constructor(options = {}) {
    if (typeof options.sendToCodex !== "function") {
      throw new Error("sendToCodex(item) is required");
    }
    this.sendToCodex = options.sendToCodex;
    this.onDispatchError = options.onDispatchError || null;
    this.textMergeWindowMs = windowOption(options, "textMergeWindowMs", DEFAULT_TEXT_MERGE_WINDOW_MS);
    this.voiceMergeWindowMs = windowOption(options, "voiceMergeWindowMs", DEFAULT_VOICE_MERGE_WINDOW_MS);
    this.mediaMergeWindowMs = windowOption(options, "mediaMergeWindowMs", DEFAULT_MEDIA_MERGE_WINDOW_MS);
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.pendingFileLimit = options.pendingFileLimit ?? DEFAULT_PENDING_FILE_LIMIT;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.now = options.now || (() => Date.now());
    this.pendingAttachments = new Map();
    this.composing = new Map();
    this.queue = [];
    this.busy = false;
    this.active = null;
    this.settleTimer = null;
  }

  receive(input = {}) {
    const target = input.target || {};
    const key = targetKey(target);
    const text = String(input.text || "").trim();
    const saved = Array.isArray(input.saved) ? input.saved : [];
    const errors = Array.isArray(input.errors) ? input.errors : [];
    const triggerMedia = saved.filter(isTriggerMedia);
    const heldMedia = saved.filter((item) => !isTriggerMedia(item));

    if (!text && triggerMedia.length === 0) {
      if (heldMedia.length || errors.length) {
        if (this.mergeIntoQueued(key, heldMedia, errors)) {
          return { status: "merged_queued", held: heldMedia.length, errors: errors.length };
        }
        this.holdAttachments(key, target, heldMedia, errors);
        return { status: "held", held: heldMedia.length, errors: errors.length };
      }
      return { status: "ignored" };
    }

    const held = this.pendingAttachments.get(key) || emptyHeld(target, this.now());
    this.pendingAttachments.delete(key);
    const entry = this.composing.get(key) || {
      key,
      target,
      texts: [],
      media: [],
      errors: [],
      warnings: [],
      timer: null
    };

    entry.target = target;
    if (text) entry.texts.push(text);
    entry.media.push(...held.media, ...heldMedia, ...triggerMedia);
    entry.errors.push(...held.errors, ...errors);
    entry.warnings.push(...pendingWarnings(held, this.now(), this.pendingTtlMs, this.pendingFileLimit));
    entry.flushDelayMs = Math.max(
      entry.flushDelayMs || 0,
      this.flushDelayFor({ text, held, heldMedia, triggerMedia, errors })
    );
    this.composing.set(key, entry);
    this.scheduleFlush(key, entry);
    return { status: "composing", media: entry.media.length, errors: entry.errors.length, flushDelayMs: entry.flushDelayMs };
  }

  holdAttachments(key, target, media, errors) {
    const held = this.pendingAttachments.get(key) || emptyHeld(target, this.now());
    held.target = target;
    held.media.push(...media);
    held.errors.push(...errors);
    this.pendingAttachments.set(key, held);
  }

  scheduleFlush(key, entry) {
    if (entry.timer) this.clearTimer(entry.timer);
    const delay = entry.flushDelayMs || 0;
    if (delay <= 0) {
      this.flush(key);
      return;
    }
    entry.timer = this.setTimer(() => this.flush(key), delay);
  }

  flush(key) {
    const entry = this.composing.get(key);
    if (!entry) return null;
    if (entry.timer) this.clearTimer(entry.timer);
    this.composing.delete(key);
    const item = {
      key,
      target: entry.target,
      texts: entry.texts,
      media: entry.media,
      errors: entry.errors,
      warnings: entry.warnings || []
    };
    item.payload = buildCodexPayload(item);
    this.enqueue(item);
    return item;
  }

  flushAll() {
    return [...this.composing.keys()].map((key) => this.flush(key)).filter(Boolean);
  }

  enqueue(item) {
    if (this.busy) {
      if (this.mergeItemIntoQueued(item)) {
        return { status: "merged_queued", size: this.queue.length };
      }
      this.queue.push(item);
      return { status: "queued", size: this.queue.length };
    }
    this.dispatch(item);
    return { status: "dispatched" };
  }

  dispatch(item) {
    if (this.settleTimer) {
      this.clearTimer(this.settleTimer);
      this.settleTimer = null;
    }
    this.busy = true;
    this.active = item;
    try {
      Promise.resolve(this.sendToCodex(item)).catch((error) => this.handleDispatchError(error, item));
    } catch (error) {
      this.handleDispatchError(error, item);
    }
  }

  handleDispatchError(error, item) {
    this.busy = false;
    this.active = null;
    if (this.onDispatchError) this.onDispatchError(error, item);
    this.processNext();
  }

  markSettled() {
    if (!this.busy) return;
    this.busy = false;
    this.active = null;
    this.scheduleProcessNext();
  }

  scheduleProcessNext() {
    if (this.busy || this.settleTimer || this.queue.length === 0) return;
    if (this.settleDelayMs <= 0) {
      this.processNext();
      return;
    }
    this.settleTimer = this.setTimer(() => {
      this.settleTimer = null;
      this.processNext();
    }, this.settleDelayMs);
  }

  processNext() {
    if (this.settleTimer) {
      this.clearTimer(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.busy) return;
    const next = this.queue.shift();
    if (next) this.dispatch(next);
  }

  flushDelayFor({ text, held, heldMedia, triggerMedia, errors }) {
    const hasVoice = triggerMedia.length > 0;
    const hasMedia = hasVoice || heldMedia.length > 0 || errors.length > 0 || held.media.length > 0 || held.errors.length > 0;
    if (hasMedia) return hasVoice ? Math.max(this.voiceMergeWindowMs, this.mediaMergeWindowMs) : this.mediaMergeWindowMs;
    return text ? this.textMergeWindowMs : 0;
  }

  mergeIntoQueued(key, media, errors) {
    if (!this.busy || this.queue.length === 0) return false;
    const queued = findLastQueued(this.queue, key);
    if (!queued) return false;
    queued.media.push(...media);
    queued.errors.push(...errors);
    queued.payload = buildCodexPayload(queued);
    return true;
  }

  mergeItemIntoQueued(item) {
    const queued = findLastQueued(this.queue, item.key);
    if (!queued) return false;
    queued.texts.push(...item.texts);
    queued.media.push(...item.media);
    queued.errors.push(...item.errors);
    queued.warnings.push(...(item.warnings || []));
    queued.payload = buildCodexPayload(queued);
    return true;
  }
}

function buildCodexPayload(item) {
  const lines = [];
  const text = item.texts.filter(Boolean).join("\n");
  if (text) lines.push(text);

  if (item.media.length) {
    if (lines.length) lines.push("");
    if (item.media.some((media) => media.type === "voice")) {
      lines.push("Wechat voice/audio files are included below as fallback. Use the text content first; only inspect or transcribe local audio if the text is missing or unclear.");
      lines.push("");
    }
    lines.push("Wechat attachments saved locally:");
    for (const media of item.media) {
      const name = media.fileName ? ` (${media.fileName})` : "";
      const transcript = media.transcript && !text.includes(media.transcript)
        ? `, channel transcript reference: ${media.transcript}`
        : "";
      lines.push(`- ${media.type}${name}: ${media.path}${transcript}`);
    }
    lines.push("", "Use the local file paths above when handling this message.");
  }

  if (item.errors.length) {
    if (lines.length) lines.push("");
    lines.push("Attachment save failures:");
    for (const error of item.errors) {
      const name = error.fileName ? ` (${error.fileName})` : "";
      lines.push(`- ${error.type || "media"}${name}: ${error.error}`);
    }
  }

  if (item.warnings && item.warnings.length) {
    if (lines.length) lines.push("");
    lines.push("Attachment context notes:");
    for (const warning of item.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n").trim();
}

function isTriggerMedia(item) {
  return item && item.type === "voice";
}

function targetKey(target) {
  return String(target.toUserId || target.fromUserId || "default");
}

function windowOption(options, key, defaultValue) {
  if (options[key] !== undefined) return options[key];
  if (options.mergeWindowMs !== undefined) return options.mergeWindowMs;
  return defaultValue;
}

function emptyHeld(target, createdAt) {
  return { target, media: [], errors: [], createdAt };
}

function findLastQueued(queue, key) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) return queue[i];
  }
  return null;
}

function pendingWarnings(held, now, ttlMs, fileLimit) {
  if (!held || held.createdAt === undefined || held.createdAt === null) return [];
  const warnings = [];
  const count = held.media.length + held.errors.length;
  if (count === 0) return warnings;
  if (ttlMs > 0 && now - held.createdAt > ttlMs) {
    warnings.push(`Includes attachments that were sent more than ${formatDuration(ttlMs)} before this text/voice trigger.`);
  }
  if (fileLimit > 0 && count > fileLimit) {
    warnings.push(`Includes ${count} pending attachment entries, exceeding the usual ${fileLimit}-file grouping limit; none were dropped.`);
  }
  return warnings;
}

function formatDuration(ms) {
  if (ms >= 60 * 1000) {
    const minutes = Math.round(ms / (60 * 1000));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

module.exports = {
  InboundMessageQueue,
  buildCodexPayload
};
