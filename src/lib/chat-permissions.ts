/**
 * Session-scoped permission decisions for agent write effects.
 *
 * Reads are covered by the workspace grant itself; every durable write stops
 * at a prompt showing the exact diff, Claude-Code style: allow once,
 * always allow for this file in this session, or reject. "Always" grants
 * live in tab memory only and never persist.
 */

import { normalizeWorkspacePath } from "./workspace";

export type PermissionDecision = "allow-once" | "always-allow" | "reject";

export interface WritePermissionRequest {
  path: string;
  /** Readable unified diff of the exact proposed change. */
  diff: string;
  /** True when the file does not exist yet. */
  creates: boolean;
  beforeBytes: number;
  afterBytes: number;
  /** Optional hatchling identity when multiple hatchlings share one session UI. */
  threadId?: string;
  threadName?: string;
  /** Distinguishes workspace file writes from external connector/MCP side effects. */
  kind?: "workspace" | "external";
}

export type PermissionGate = (
  request: WritePermissionRequest,
  options?: { signal?: AbortSignal }
) => Promise<PermissionDecision>;

function normalizePermissionKey(path: string): string {
  if (path.startsWith("external:")) {
    const target = path.slice("external:".length).trim();
    if (!target || target.length > 256 || /[\u0000-\u001f\u007f]/.test(target)) {
      throw new Error("Invalid external permission key.");
    }
    return `external:${target}`;
  }
  return normalizeWorkspacePath(path);
}

export class SessionPermissionStore {
  private readonly alwaysAllowed = new Set<string>();

  isAlwaysAllowed(path: string): boolean {
    return this.alwaysAllowed.has(normalizePermissionKey(path));
  }

  record(path: string, decision: PermissionDecision): void {
    if (decision === "always-allow") {
      this.alwaysAllowed.add(normalizePermissionKey(path));
    }
  }

  grantedPaths(): string[] {
    return [...this.alwaysAllowed].sort();
  }

  revoke(path: string): void {
    this.alwaysAllowed.delete(normalizePermissionKey(path));
  }

  clear(): void {
    this.alwaysAllowed.clear();
  }
}
