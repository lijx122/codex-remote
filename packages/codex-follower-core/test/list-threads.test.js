"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("better-sqlite3");
const { CodexFollowerCore } = require("../src");

const ids = {
  userIndexed: "11111111-1111-4111-8111-111111111111",
  subIndexedMeta: "22222222-2222-4222-8222-222222222222",
  subIndexedDb: "33333333-3333-4333-8333-333333333333",
  userDbOnly: "44444444-4444-4444-8444-444444444444",
  subDbOnly: "55555555-5555-4555-8555-555555555555",
  userBroadcast: "66666666-6666-4666-8666-666666666666",
  subBroadcast: "77777777-7777-4777-8777-777777777777",
  rolloutOnlyFinal: "88888888-8888-4888-8888-888888888888",
  rolloutLifecycle: "99999999-9999-4999-8999-999999999999",
  v11Broadcast: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  resetBroadcast: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-follower-"));

try {
  writeSessionIndex(tmp, [
    { id: ids.userIndexed, thread_name: "indexed user", updated_at: "2026-01-01T00:00:00.000Z" },
    { id: ids.subIndexedMeta, thread_name: "indexed sub meta", updated_at: "2026-01-02T00:00:00.000Z" },
    { id: ids.subIndexedDb, thread_name: "indexed sub db", updated_at: "2026-01-03T00:00:00.000Z" },
  ]);

  writeRollout(tmp, ids.userIndexed, { thread_source: "user", cwd: "F:\\user" });
  writeRollout(tmp, ids.subIndexedMeta, { thread_source: "subagent", cwd: "F:\\sub" });
  writeRollout(tmp, ids.userDbOnly, { thread_source: "user", cwd: "F:\\db-user" });
  writeRollout(tmp, ids.subDbOnly, { thread_source: "user", cwd: "F:\\db-sub" });
  writeRollout(tmp, ids.rolloutOnlyFinal, { thread_source: "user", cwd: "F:\\rollout-final" });
  writeRollout(tmp, ids.rolloutLifecycle, { thread_source: "user", cwd: "F:\\rollout-lifecycle" });

  writeStateDb(tmp, [
    { id: ids.subIndexedDb, title: "indexed sub db", archived: 0, thread_source: "subagent" },
    { id: ids.userDbOnly, title: "db user", archived: 0, thread_source: "user" },
    {
      id: ids.subDbOnly,
      title: "db sub",
      archived: 0,
      source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ids.userIndexed } } }),
      thread_source: "subagent",
    },
  ]);

  const core = new CodexFollowerCore({ codexHome: tmp });
  core.threads.set(ids.userBroadcast, {
    id: ids.userBroadcast,
    title: "broadcast user",
    updatedAt: "2026-01-04T00:00:00.000Z",
    raw: { thread_source: "user" },
  });
  core.threads.set(ids.subBroadcast, {
    id: ids.subBroadcast,
    title: "broadcast sub",
    updatedAt: "2026-01-05T00:00:00.000Z",
    raw: { thread_source: "subagent" },
  });

  const listedIds = new Set(core.listThreads().map((thread) => thread.id));

  assert.equal(listedIds.has(ids.userIndexed), true);
  assert.equal(listedIds.has(ids.userDbOnly), true);
  assert.equal(listedIds.has(ids.userBroadcast), true);

  assert.equal(listedIds.has(ids.subIndexedMeta), false);
  assert.equal(listedIds.has(ids.subIndexedDb), false);
  assert.equal(listedIds.has(ids.subDbOnly), false);
  assert.equal(listedIds.has(ids.subBroadcast), false);

  let interruptedTurn = null;
  core.events.on("turn_interrupted", (event) => {
    interruptedTurn = event;
  });
  core.handleBroadcast({
    method: "thread-stream-state-changed",
    params: {
      conversationId: ids.userBroadcast,
      change: {
        conversationState: {
          title: "broadcast user",
          turns: [
            { turnId: "turn-canceled", status: "interrupted" }
          ]
        }
      }
    }
  });
  assert.equal(interruptedTurn && interruptedTurn.turnId, "turn-canceled");

  let completedTurn = null;
  core.events.on("turn_completed", (event) => {
    completedTurn = event;
  });
  core.handleBroadcast({
    method: "thread-stream-state-changed",
    params: {
      conversationId: ids.userBroadcast,
      change: {
        conversationState: canonicalState("turn-completed", "completed")
      }
    }
  });
  assert.equal(completedTurn && completedTurn.turnId, "turn-completed");

  appendRolloutMessages(tmp, ids.rolloutOnlyFinal, [
    userResponse("final-only-turn", "new user"),
    assistantResponse("final-only-turn", "new final")
  ]);
  const rolloutCompletedTurns = [];
  core.events.on("turn_completed", (event) => {
    if (event.conversationId === ids.rolloutOnlyFinal) rolloutCompletedTurns.push(event);
  });
  core.publishTurnEvents(
    ids.rolloutOnlyFinal,
    core.loadLocalHistory(ids.rolloutOnlyFinal),
    {}
  );
  assert.equal(rolloutCompletedTurns.length, 0, "final_answer without task_complete must not complete the turn");

  const lifecycleTurnId = "rollout-lifecycle-turn";
  const lifecycleCompletedTurns = [];
  core.events.on("turn_completed", (event) => {
    if (event.conversationId === ids.rolloutLifecycle) lifecycleCompletedTurns.push(event);
  });

  appendRolloutRecords(tmp, ids.rolloutLifecycle, [rolloutEvent(lifecycleTurnId, "task_started")]);
  let lifecycleState = core.loadLocalHistory(ids.rolloutLifecycle);
  assert.equal(lifecycleState.turns.at(-1).status, "running");

  appendRolloutMessages(tmp, ids.rolloutLifecycle, [
    assistantResponse(lifecycleTurnId, "Handoff: continue this task in the next session.")
  ]);
  lifecycleState = core.loadLocalHistory(ids.rolloutLifecycle);
  core.publishTurnEvents(ids.rolloutLifecycle, lifecycleState, {});
  assert.equal(lifecycleState.turns.at(-1).status, "running");
  assert.equal(lifecycleCompletedTurns.length, 0);

  appendRolloutMessages(tmp, ids.rolloutLifecycle, [
    assistantResponse(lifecycleTurnId, "中文最终答复。")
  ]);
  lifecycleState = core.loadLocalHistory(ids.rolloutLifecycle);
  core.publishTurnEvents(ids.rolloutLifecycle, lifecycleState, {});
  assert.equal(lifecycleState.turns.at(-1).status, "running");
  assert.equal(lifecycleCompletedTurns.length, 0);

  appendRolloutRecords(tmp, ids.rolloutLifecycle, [rolloutEvent(lifecycleTurnId, "task_complete")]);
  lifecycleState = core.loadLocalHistory(ids.rolloutLifecycle);
  core.publishTurnEvents(ids.rolloutLifecycle, lifecycleState, {});
  core.publishTurnEvents(ids.rolloutLifecycle, lifecycleState, {});
  assert.equal(lifecycleState.turns.at(-1).status, "completed");
  assert.deepEqual(
    lifecycleState.turns.at(-1).items.filter((item) => item.phase === "final_answer").map((item) => item.text),
    ["Handoff: continue this task in the next session.", "中文最终答复。"]
  );
  assert.equal(lifecycleCompletedTurns.length, 1);
  assert.equal(lifecycleCompletedTurns[0].turnId, lifecycleTurnId);

  const snapshot = v11State("v11 snapshot", "running");
  core.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId: ids.v11Broadcast,
      change: { type: "snapshot", revision: 10, conversationState: snapshot }
    }
  });
  assert.equal(core.histories.get(ids.v11Broadcast).revision, 10);
  assert.equal(core.listThreads().find((thread) => thread.id === ids.v11Broadcast).title, "v11 snapshot");

  const patch = {
    type: "patches",
    baseRevision: 10,
    revision: 11,
    patches: [
      { op: "replace", path: ["title"], value: "v11 patched" },
      { op: "add", path: ["threadRuntimeStatus"], value: { type: "active" } }
    ]
  };
  core.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: { conversationId: ids.v11Broadcast, change: patch }
  });
  assert.equal(core.histories.get(ids.v11Broadcast).revision, 11);
  assert.equal(core.histories.get(ids.v11Broadcast).title, "v11 patched");
  const patchedThread = core.listThreads().find((thread) => thread.id === ids.v11Broadcast);
  assert.equal(patchedThread.title, "v11 patched");
  assert.deepEqual(patchedThread.runtimeStatus, { type: "active" });

  const patchedState = JSON.stringify(core.histories.get(ids.v11Broadcast));
  core.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: { conversationId: ids.v11Broadcast, change: patch }
  });
  assert.equal(JSON.stringify(core.histories.get(ids.v11Broadcast)), patchedState);

  core.handleBroadcast({
    type: "broadcast",
    version: 11,
    method: "thread-stream-state-changed",
    params: {
      conversationId: ids.v11Broadcast,
      change: {
        type: "patches",
        baseRevision: 13,
        revision: 14,
        patches: [{ op: "replace", path: ["title"], value: "gap polluted" }]
      }
    }
  });
  assert.equal(core.histories.get(ids.v11Broadcast).revision, 11);
  assert.equal(core.histories.get(ids.v11Broadcast).title, "v11 patched");
  assert.equal(
    core.listThreads().some((thread) => thread.id === ids.v11Broadcast && thread.sendable),
    false
  );

  const ownerResetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  core.handleBroadcast({
    sourceClientId: "desktop-owner-a",
    method: "thread-stream-state-changed",
    params: {
      conversationId: ownerResetId,
      change: { type: "snapshot", revision: 1, conversationState: { title: "owner a", turns: [] } }
    }
  });
  core.handleBroadcast({
    sourceClientId: "desktop-owner-b",
    method: "thread-stream-state-changed",
    params: {
      conversationId: ownerResetId,
      change: { type: "snapshot", revision: 2, conversationState: { title: "owner b", turns: [] } }
    }
  });
  assert.equal(core.histories.get(ownerResetId).title, "owner b");
  assert.equal(core.listThreads().some((thread) => thread.id === ownerResetId && thread.sendable), true);

  const nestedPatchId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  core.handleBroadcast({
    sourceClientId: "desktop-owner-b",
    method: "thread-stream-state-changed",
    params: {
      conversationId: nestedPatchId,
      change: { type: "snapshot", revision: 1, conversationState: { title: "nested", turnHistory: null, turns: [] } }
    }
  });
  core.handleBroadcast({
    sourceClientId: "desktop-owner-b",
    method: "thread-stream-state-changed",
    params: {
      conversationId: nestedPatchId,
      change: {
        type: "patch",
        baseRevision: 1,
        revision: 2,
        patch: [{
          op: "add",
          path: "/turnHistory/history/entitiesByKey/turn:nested",
          value: { turnId: "nested", status: "running", items: [] }
        }]
      }
    }
  });
  assert.equal(core.histories.get(nestedPatchId).revision, 2);
  assert.equal(
    core.histories.get(nestedPatchId).turnHistory.history.entitiesByKey["turn:nested"].turnId,
    "nested"
  );

  core.handleBroadcast({
    method: "thread-stream-state-changed",
    params: {
      conversationId: ids.resetBroadcast,
      change: { conversationState: canonicalState("reset-turn", "running") }
    }
  });
  assert.equal(core.listThreads().some((thread) => thread.id === ids.resetBroadcast && thread.sendable), true);
  core.handleBroadcast({ method: "ipc-connection-reset", params: {} });
  assert.equal(
    core.listThreads().some((thread) => thread.id === ids.resetBroadcast && thread.sendable),
    false
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function writeSessionIndex(root, entries) {
  fs.writeFileSync(
    path.join(root, "session_index.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
}

function writeRollout(root, id, meta) {
  const dir = path.join(root, "sessions", "2026", "01", "01");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id, ...meta } }) + "\n",
    "utf8"
  );
}

function appendRolloutMessages(root, id, messages) {
  appendRolloutRecords(
    root,
    id,
    messages.map((payload) => ({ type: "response_item", payload }))
  );
}

function appendRolloutRecords(root, id, records) {
  const filePath = path.join(root, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  fs.appendFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8"
  );
}

function rolloutEvent(turnId, type) {
  return {
    type: "event_msg",
    payload: { type, turn_id: turnId }
  };
}

function userResponse(turnId, text) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  };
}

function assistantResponse(turnId, text) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    phase: "final_answer",
    internal_chat_message_metadata_passthrough: { turn_id: turnId }
  };
}

function writeStateDb(root, rows) {
  const db = new Database(path.join(root, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      archived INTEGER,
      source TEXT,
      thread_source TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads (id, title, archived, source, thread_source)
    VALUES (@id, @title, @archived, @source, @thread_source)
  `);
  for (const row of rows) {
    insert.run({
      id: row.id,
      title: row.title,
      archived: row.archived || 0,
      source: row.source || null,
      thread_source: row.thread_source || null,
    });
  }
  db.close();
}

function canonicalState(turnId, status, options = {}) {
  const includeFinal = options.includeFinal !== false;
  const items = status === "completed" && includeFinal
    ? [{
      type: "agentMessage",
      text: "broadcast final",
      phase: "final_answer"
    }]
    : [];
  return {
    title: "broadcast user",
    turns: [],
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: {
          [`turn:${turnId}`]: {
            turnId,
            turnStartedAtMs: 100,
            status,
            items
          }
        }
      }
    }
  };
}

function v11State(title, status) {
  return {
    title,
    threadRuntimeStatus: { type: status },
    turns: [{ turnId: "v11-turn", status, items: [] }]
  };
}
