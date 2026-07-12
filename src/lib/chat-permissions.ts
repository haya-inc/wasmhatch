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
}

export type PermissionGate = (request: WritePermissionRequest) => Promise<PermissionDecision>;

export class SessionPermissionStore {
  private readonly alwaysAllowed = new Set<string>();

  isAlwaysAllowed(path: string): boolean {
    return this.alwaysAllowed.has(normalizeWorkspacePath(path));
  }

  record(path: string, decision: PermissionDecision): void {
    if (decision === "always-allow") {
      this.alwaysAllowed.add(normalizeWorkspacePath(path));
    }
  }

  grantedPaths(): string[] {
    return [...this.alwaysAllowed].sort();
  }

  revoke(path: string): void {
    this.alwaysAllowed.delete(normalizeWorkspacePath(path));
  }

  clear(): void {
    this.alwaysAllowed.clear();
  }
}
