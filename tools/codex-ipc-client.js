#!/usr/bin/env node
"use strict";

const net = require("node:net");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

const PIPE_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : `${require("node:os").tmpdir()}/codex-ipc/ipc.sock`;

const COMMAND = process.argv[2] || "init";
const CLIENT_TYPE = process.env.CODEX_IPC_CLIENT_TYPE || "external-follower-probe";
const LISTEN_MS = Number(process.env.CODEX_IPC_LISTEN_MS || "3000");
const LOG_FILE = process.env.CODEX_IPC_LOG || "";
const SUBMIT_PARAMS_JSON = process.env.CODEX_IPC_SUBMIT_PARAMS_JSON || "";
const VERSIONS = {
  "thread-stream-state-changed": 7,
  "thread-read-state-changed": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 2,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1,
};

let clientId = "initializing-client";
let pending = Buffer.alloc(0);
const pendingMethods = new Map();

function logLine(kind, value) {
  const text = `${kind} ${typeof value === "string" ? value : JSON.stringify(value)}`;
  console.log(text);
  if (LOG_FILE) {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), kind, value }) + "\n",
      "utf8",
    );
  }
}

function encodeFrame(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function writeMessage(socket, message) {
  socket.write(encodeFrame(message));
  logLine("SEND", message);
}

function readFrames(chunk, onMessage) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (length === 0 || length > 256 * 1024 * 1024) {
      throw new Error(`invalid frame length: ${length}`);
    }
    if (pending.length < 4 + length) return;
    const body = pending.subarray(4, 4 + length);
    pending = pending.subarray(4 + length);
    onMessage(JSON.parse(body.toString("utf8")));
  }
}

const socket = net.createConnection(PIPE_PATH);

function usage() {
  console.log(`Usage:
  node tools/codex-ipc-client.js init
  node tools/codex-ipc-client.js listen
  node tools/codex-ipc-client.js request <method> [params-json]
  node tools/codex-ipc-client.js history <conversation-id>
  node tools/codex-ipc-client.js follow <conversation-id> [text]

Examples:
  node tools/codex-ipc-client.js init
  node tools/codex-ipc-client.js request thread-follower-load-complete-history "{\\"conversationId\\":\\"THREAD_ID\\"}"
  node tools/codex-ipc-client.js history THREAD_ID
  node tools/codex-ipc-client.js follow THREAD_ID "hello from ipc probe"

Environment:
  CODEX_IPC_LISTEN_MS=3000
  CODEX_IPC_CLIENT_TYPE=external-follower-probe
  CODEX_IPC_LOG=reports/codex-ipc-runtime.log
  CODEX_IPC_SUBMIT_PARAMS_JSON={\\"conversationId\\":\\"THREAD_ID\\",\\"text\\":\\"hello\\"}`);
}

function sendInitialize() {
  const requestId = randomUUID();
  pendingMethods.set(requestId, "initialize");
  writeMessage(socket, {
    type: "request",
    requestId,
    sourceClientId: clientId,
    version: 0,
    method: "initialize",
    params: { clientType: CLIENT_TYPE },
  });
}

function sendRequest(method, params) {
  const requestId = randomUUID();
  pendingMethods.set(requestId, method);
  writeMessage(socket, {
    type: "request",
    requestId,
    sourceClientId: clientId,
    version: VERSIONS[method] || 0,
    method,
    params,
  });
}

function handleRouterRequest(message) {
  if (message.type !== "client-discovery-request") return false;
  writeMessage(socket, {
    type: "client-discovery-response",
    requestId: message.requestId,
    response: { canHandle: false },
  });
  return true;
}

function parseJsonArg(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    logLine("ERROR", `invalid JSON: ${error.message}`);
    socket.end();
    return null;
  }
}

function historyParamsFromArg() {
  const conversationId = process.argv[3];
  if (!conversationId) {
    logLine("ERROR", "missing conversationId");
    socket.end();
    return null;
  }
  return { conversationId };
}

function submitParamsFromArgs() {
  const conversationId = process.argv[3];
  const text = process.argv[4] || "hello from ipc probe";
  if (!conversationId) {
    logLine("ERROR", "missing conversationId");
    socket.end();
    return null;
  }
  if (SUBMIT_PARAMS_JSON) {
    return parseJsonArg(SUBMIT_PARAMS_JSON, null);
  }
  return { conversationId, text };
}

function isSuccessResponse(message, method) {
  return (
    message.type === "response" &&
    (message.method === method || pendingMethods.get(message.requestId) === method) &&
    message.resultType === "success"
  );
}

if (COMMAND === "help" || COMMAND === "--help" || COMMAND === "-h") {
  usage();
  process.exit(0);
}

socket.on("connect", () => {
  logLine("CONNECTED", PIPE_PATH);
  sendInitialize();
});

socket.on("data", (chunk) => {
  readFrames(chunk, (message) => {
    logLine("RECV", message);
    if (handleRouterRequest(message)) return;
    if (
      message.type === "response" &&
      message.method === "initialize" &&
      message.resultType === "success" &&
      message.result &&
      typeof message.result.clientId === "string"
    ) {
      clientId = message.result.clientId;
      logLine("CLIENT_ID", clientId);
      if (COMMAND === "request") {
        const method = process.argv[3];
        if (!method) {
          logLine("ERROR", "missing method");
          socket.end();
          return;
        }
        let params = {};
        if (process.argv[4]) {
          try {
            params = JSON.parse(process.argv[4]);
          } catch (error) {
            logLine("ERROR", `invalid params JSON: ${error.message}`);
            socket.end();
            return;
          }
        }
        sendRequest(method, params);
      } else if (COMMAND === "history" || COMMAND === "follow") {
        const params = historyParamsFromArg();
        if (params) {
          sendRequest("thread-follower-load-complete-history", params);
        }
      }
      setTimeout(() => {
        logLine("LISTEN_DONE", `${LISTEN_MS}ms`);
        socket.end();
      }, LISTEN_MS);
    } else if (
      COMMAND === "follow" &&
      isSuccessResponse(message, "thread-follower-load-complete-history")
    ) {
      const params = submitParamsFromArgs();
      if (params) {
        sendRequest("thread-follower-submit-user-input", params);
      }
    }
    if (message.type === "response") {
      pendingMethods.delete(message.requestId);
    }
  });
});

socket.on("error", (error) => {
  logLine("ERROR", error.message);
  process.exitCode = 1;
});

socket.on("close", () => {
  logLine("CLOSED", "");
});
