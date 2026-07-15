"use strict";

const assert = require("node:assert/strict");
const { AppServerTransport } = require("../src/app-server-transport");
const { CodexFollowerCore } = require("../src");

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

assert.equal(new CodexFollowerCore().transport.constructor.name, "AppServerTransport");
assert.equal(
  new CodexFollowerCore().buildStartTurnParams(conversationId, "test", {}).approvalPolicy,
  "untrusted"
);

const previousApprovalPolicy = process.env.CODEX_APPROVAL_POLICY;
process.env.CODEX_APPROVAL_POLICY = "untrusted";
const policyCore = new CodexFollowerCore();
assert.equal(
  policyCore.buildStartTurnParams(conversationId, "test", {
    latestThreadSettings: { approvalPolicy: "never" },
    currentPermissions: { approvalPolicy: "never" }
  }).approvalPolicy,
  "untrusted"
);
if (previousApprovalPolicy === undefined) delete process.env.CODEX_APPROVAL_POLICY;
else process.env.CODEX_APPROVAL_POLICY = previousApprovalPolicy;

const transport = new AppServerTransport();
const broadcasts = [];
transport.on("broadcast", (message) => broadcasts.push(message));
transport.setThread({ id: conversationId, name: "app-server thread" }, true);
assert.equal(broadcasts.length, 1);
assert.equal(broadcasts[0].params.conversationId, conversationId);

transport.updateTurn(conversationId, {
  id: "turn-1",
  status: "inProgress",
  items: [{ id: "item-1", type: "agentMessage", text: "partial" }]
}, false);
transport.updateTurn(conversationId, {
  id: "turn-1",
  status: "completed"
}, false);
const completedTurn = transport.states.get(conversationId).turns[0];
assert.equal(completedTurn.status, "completed");
assert.equal(completedTurn.items[0].text, "partial");

const fakeTransport = {
  on() {},
  request() {},
  send() {},
  disconnect() {}
};
const core = new CodexFollowerCore({ transport: fakeTransport });
let interrupted;
core.events.on("turn_interrupted", (event) => {
  interrupted = event;
});
core.handleBroadcast({
  sourceClientId: "app-server-test",
  method: "thread-stream-state-changed",
  params: {
    conversationId,
    change: {
      type: "snapshot",
      revision: 1,
      conversationState: {
        id: conversationId,
        turns: [{ turnId: "turn-failed", status: "failed", items: [] }]
      }
    }
  }
});
assert.equal(interrupted.turnId, "turn-failed");
assert.equal(interrupted.status, "failed");

process.stdout.write("app-server transport test passed\n");
