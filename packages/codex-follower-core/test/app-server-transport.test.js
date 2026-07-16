"use strict";

const assert = require("node:assert/strict");
const { AppServerTransport } = require("../src/app-server-transport");
const { IpcTransport } = require("../src/ipc-transport");
const { CodexFollowerCore } = require("../src");

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

assert.equal(new CodexFollowerCore().transport.constructor.name, "IpcTransport");
assert.equal(new CodexFollowerCore({ transportMode: "app-server" }).transport.constructor.name, "AppServerTransport");
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

(async () => {
  const approvalRequests = [];
  const approvalTransport = {
    requests: [],
    on() {},
    request(method, params) {
      this.requests.push({ method, params });
      return Promise.resolve({ resultType: "success" });
    },
    send() {},
    disconnect() {}
  };
  const approvalCore = new CodexFollowerCore({ transport: approvalTransport });
  approvalCore.events.on("approval_request", (event) => approvalRequests.push(event));
  approvalCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "snapshot",
        revision: 1,
        conversationState: {
          title: "approval",
          requests: {
            method: "item/commandExecution/requestApproval",
            id: 897,
            params: {
              command: "Get-Date",
              cwd: "F:\\approval",
              availableDecisions: ["accept", "cancel"],
              itemId: "item-approval-1",
              turnId: "turn-approval-1"
            }
          },
          turns: []
        }
      }
    }
  });
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].approvalId, "897");
  assert.equal(approvalRequests[0].raw.params.command, "Get-Date");
  const replayedApprovals = [];
  const scoped = approvalCore.subscribeEvents(conversationId);
  scoped.on("approval_request", (event) => replayedApprovals.push(event));
  await Promise.resolve();
  assert.equal(replayedApprovals.length, 1, "existing IPC approval must replay to a new iLink subscription");
  if (scoped.unsubscribe) scoped.unsubscribe();
  approvalCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "patches",
        baseRevision: 1,
        revision: 2,
        patches: [{
          op: "replace",
          path: ["requests"],
          value: {
            method: "item/commandExecution/requestApproval",
            id: 897,
            params: {
              command: "Get-Date",
              cwd: "F:\\approval",
              availableDecisions: ["accept", "cancel"],
              itemId: "item-approval-1",
              turnId: "turn-approval-1"
            }
          }
        }]
      }
    }
  });
  assert.equal(approvalRequests.length, 1, "same IPC approval must not duplicate");
  await approvalCore.approve(conversationId, "897", "allow");
  assert.deepEqual(approvalTransport.requests[0], {
    method: "thread-follower-command-approval-decision",
    params: { conversationId, requestId: 897, decision: "accept" }
  });
  approvalCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "snapshot",
        revision: 3,
        conversationState: {
          title: "approval",
          requests: {
            method: "item/commandExecution/requestApproval",
            id: 898,
            params: {
              command: "Get-Date",
              cwd: "F:\\approval",
              availableDecisions: ["accept", "decline"],
              itemId: "item-approval-2",
              turnId: "turn-approval-2"
            }
          },
          turns: []
        }
      }
    }
  });
  await approvalCore.approve(conversationId, "898", "deny");
  assert.deepEqual(approvalTransport.requests[1], {
    method: "thread-follower-command-approval-decision",
    params: { conversationId, requestId: 898, decision: "decline" }
  });
  approvalCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "snapshot",
        revision: 4,
        conversationState: {
          title: "approval",
          requests: {
            method: "item/permissions/requestApproval",
            id: 899,
            params: {
              permissions: { fileSystem: { read: true } },
              reason: "temporary read access",
              turnId: "turn-approval-3"
            }
          },
          turns: []
        }
      }
    }
  });
  await approvalCore.approve(conversationId, "899", "allow");
  assert.deepEqual(approvalTransport.requests[2], {
    method: "thread-follower-permissions-request-approval-response",
    params: {
      conversationId,
      requestId: 899,
      response: {
        permissions: { fileSystem: {}, network: {} },
        scope: "turn",
        strictAutoReview: false
      }
    }
  });

  const disconnectingTransport = {
    requests: [],
    on() {},
    request(method, params) {
      this.requests.push({ method, params });
      return Promise.reject(new Error("codex IPC connection closed"));
    },
    send() {},
    disconnect() {}
  };
  const disconnectingCore = new CodexFollowerCore({ transport: disconnectingTransport });
  disconnectingCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "snapshot",
        revision: 5,
        conversationState: {
          title: "approval",
          requests: {
            method: "item/permissions/requestApproval",
            id: 900,
            params: {
              permissions: { fileSystem: { read: true } },
              reason: "temporary read access",
              turnId: "turn-approval-4"
            }
          },
          turns: []
        }
      }
    }
  });
  setTimeout(() => disconnectingCore.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId,
      change: {
        type: "snapshot",
        revision: 6,
        conversationState: {
          title: "approval",
          requests: [],
          turns: [{ turnId: "turn-approval-4", status: "running", items: [] }]
        }
      }
    }
  }), 10);
  const recovered = await disconnectingCore.approve(conversationId, "900", "allow");
  assert.equal(recovered.ok, true, "approval must be confirmed by live state after IPC disconnect");
  assert.equal(recovered.confirmed, true);
  process.stdout.write("app-server transport test passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
