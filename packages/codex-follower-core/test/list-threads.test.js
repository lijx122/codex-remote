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
