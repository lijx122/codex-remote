import type { Server } from "node:http";
import type { CodexFollowerCore } from "../../codex-follower-core/src";

export interface ControlPlaneOptions {
  core?: CodexFollowerCore;
  coreOptions?: {
    pipePath?: string;
    clientType?: string;
    timeoutMs?: number;
  };
}

export interface ControlPlaneServer {
  server: Server;
  core: CodexFollowerCore;
  listen(port: number, host?: string): Promise<unknown>;
  close(): Promise<void>;
}

export function createControlPlaneServer(options?: ControlPlaneOptions): ControlPlaneServer;
