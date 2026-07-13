import { EventEmitter } from "node:events";

export type ApprovalDecision = "allow" | "deny";

export type CodexFollowerEventType =
  | "message"
  | "turn_started"
  | "turn_completed"
  | "turn_interrupted"
  | "approval_request"
  | "approval_response"
  | "interrupt"
  | "thread_state_changed"
  | "diagnostic"
  | "error";

export interface CodexFollowerOptions {
  pipePath?: string;
  clientType?: string;
  timeoutMs?: number;
  codexHome?: string;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string | number | null;
  sessionId: string | null;
  cwd: string | null;
  runtimeStatus: unknown;
  sendable: boolean;
  raw: unknown;
}

export interface LoadHistoryResult {
  conversationId: string;
  revision?: number;
  state: unknown | null;
  raw: unknown;
}

export interface SendMessageResult {
  ok: boolean;
  raw: unknown;
}

export interface CommandResult {
  ok: boolean;
  raw: unknown;
}

export interface CodexFollowerEvent {
  type: CodexFollowerEventType;
  conversationId?: string;
  revision?: number;
  turnId?: string;
  approvalId?: string;
  decision?: ApprovalDecision;
  role?: "user" | "assistant" | "system";
  text?: string;
  state?: unknown;
  code?: string;
  message?: string;
  error?: unknown;
  raw?: unknown;
}

export class CodexFollowerEventBus extends EventEmitter {
  publish(event: CodexFollowerEvent): void;
  unsubscribe?: () => void;
  on(event: CodexFollowerEventType | "*", listener: (event: CodexFollowerEvent) => void): this;
}

export interface WarmThreadResult {
  ok: boolean;
  conversationId?: string;
  alreadyLoaded?: boolean;
  broadcast?: boolean;
  sendable?: boolean;
  timeout?: boolean;
  error?: string;
}

export class CodexFollowerCore {
  constructor(options?: CodexFollowerOptions);
  connect(): Promise<{ clientId: string }>;
  disconnect(): void;
  listThreads(): ThreadSummary[];
  loadHistory(conversationId: string): Promise<LoadHistoryResult>;
  warmThread(conversationId: string): Promise<WarmThreadResult>;
  sendMessage(conversationId: string, text: string): Promise<SendMessageResult>;
  interrupt(conversationId: string): Promise<CommandResult>;
  approve(
    conversationId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<CommandResult>;
  subscribeEvents(conversationId: string): CodexFollowerEventBus;
}

export function createCodexFollower(options?: CodexFollowerOptions): CodexFollowerCore;
