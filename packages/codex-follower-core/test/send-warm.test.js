"use strict";

const assert = require("node:assert/strict");
const { CodexFollowerCore } = require("../src");

(async () => {
  const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const core = new CodexFollowerCore();
  core.threads.set(conversationId, { id: conversationId });
  core.streamStates.set(conversationId, { owner: "stale-owner", revision: 7, following: true });

  let sendAttempts = 0;
  let warmCalls = 0;
  core.sendMessageOnce = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) throw new Error("no-client-found");
    return { accepted: true };
  };
  core.warmThread = async (id) => {
    warmCalls += 1;
    assert.equal(id, conversationId);
    assert.equal(core.threads.has(conversationId), false);
    assert.equal(core.streamStates.has(conversationId), false);
    return { ok: true, conversationId, sendable: true };
  };

  const result = await core.sendMessage(conversationId, "hello");
  assert.equal(result.ok, true);
  assert.equal(sendAttempts, 2);
  assert.equal(warmCalls, 1);

  const sendCore = new CodexFollowerCore();
  const sent = [];
  sendCore.loadHistory = async () => ({
    state: {
      cwd: "C:\\workspace",
      latestThreadSettings: {
        model: "gpt-5.5",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
        effort: "high",
        summary: "none"
      }
    }
  });
  sendCore.transport.send = (method, params) => {
    sent.push({ method, params });
    return { accepted: true, requestId: "start-turn-request", method };
  };
  const sendResult = await sendCore.sendMessageOnce(conversationId, "runtime message");
  assert.equal(sendResult.accepted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "thread-follower-start-turn");
  assert.deepEqual(Object.keys(sent[0].params).sort(), ["conversationId", "turnStartParams"]);
  assert.equal(sent[0].params.turnStartParams.input[0].text, "runtime message");

  const warmConversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const warmCore = new CodexFollowerCore({
    openThread: async (id) => ({ ok: true, conversationId: id })
  });
  warmCore.transport.reconnect = async () => {
    warmCore.transport.emit("broadcast", {
      type: "broadcast",
      sourceClientId: "desktop-owner",
      method: "thread-stream-state-changed",
      params: {
        conversationId: warmConversationId,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: { id: warmConversationId, title: "warm target", turns: [] }
        }
      }
    });
    return { clientId: "refreshed-client" };
  };
  const warmResult = await warmCore.warmThread(warmConversationId);
  assert.equal(warmResult.ok, true);
  assert.equal(warmResult.sendable, true);
  assert.equal(warmCore.threads.has(warmConversationId), true);
  process.stdout.write("core send warm test passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
