import { describe, expect, it, vi } from "vitest";
import { SessionPermissionStore, type PermissionDecision, type WritePermissionRequest } from "./chat-permissions";
import { CHAT_READ_MAX_LINES, CHAT_WRITE_MAX_BYTES, createChatToolExecutor } from "./chat-tools";
import type { WorkspaceStore } from "./workspace";

function memoryWorkspace(initial: Record<string, string> = {}): WorkspaceStore {
  const files = new Map(Object.entries(initial));
  return {
    backend: "local-storage",
    async listFiles() {
      return [...files.keys()].sort();
    },
    async listBaselineFiles() {
      return [];
    },
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    async readBaselineFile(path: string) {
      throw new Error(`Baseline file not found: ${path}`);
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async replaceBaseline() { /* not needed */ },
    async replaceAll() { /* not needed */ },
    async clear() {
      files.clear();
    }
  };
}

function executorWith(options: {
  files?: Record<string, string>;
  decision?: PermissionDecision;
  onGate?: (request: WritePermissionRequest) => void;
}) {
  const workspace = memoryWorkspace(options.files);
  const permissions = new SessionPermissionStore();
  const gate = vi.fn(async (request: WritePermissionRequest) => {
    options.onGate?.(request);
    return options.decision ?? "allow-once";
  });
  const writes: string[] = [];
  const execute = createChatToolExecutor({
    workspace,
    permissions,
    gate,
    onWrite: (path) => writes.push(path)
  });
  return { workspace, permissions, gate, execute, writes };
}

describe("SessionPermissionStore", () => {
  it("records always-allow grants and normalizes paths", () => {
    const store = new SessionPermissionStore();
    store.record("./notes/todo.md", "always-allow");
    expect(store.isAlwaysAllowed("notes/todo.md")).toBe(true);
    expect(store.grantedPaths()).toEqual(["notes/todo.md"]);
    store.revoke("notes/todo.md");
    expect(store.isAlwaysAllowed("notes/todo.md")).toBe(false);
  });

  it("does not persist allow-once or reject decisions", () => {
    const store = new SessionPermissionStore();
    store.record("a.txt", "allow-once");
    store.record("b.txt", "reject");
    expect(store.grantedPaths()).toEqual([]);
  });
});

describe("createChatToolExecutor", () => {
  it("lists files with sizes and hides protected paths", async () => {
    const { execute } = executorWith({ files: { "readme.md": "hello", ".env": "SECRET=1" } });
    const outcome = await execute("list_files", {}, {});
    expect(outcome.isError).toBeFalsy();
    const payload = JSON.parse(outcome.content) as { files: Array<{ path: string; bytes: number }>; hidden_protected_paths: number };
    expect(payload.files).toEqual([{ path: "readme.md", bytes: 5 }]);
    expect(payload.hidden_protected_paths).toBe(1);
  });

  it("reads a line range and reports truncation", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const { execute } = executorWith({ files: { "notes.txt": lines } });
    const outcome = await execute("read_file", { path: "notes.txt", start_line: 2, end_line: 4 }, {});
    const payload = JSON.parse(outcome.content) as Record<string, unknown>;
    expect(payload.content).toBe("line 2\nline 3\nline 4");
    expect(payload.total_lines).toBe(10);
    // More lines exist after end_line, so the paging signal stays on.
    expect(payload.truncated).toBe(true);
  });

  it("caps reads at the line budget", async () => {
    const lines = Array.from({ length: CHAT_READ_MAX_LINES + 10 }, () => "x").join("\n");
    const { execute } = executorWith({ files: { "big.txt": lines } });
    const outcome = await execute("read_file", { path: "big.txt" }, {});
    const payload = JSON.parse(outcome.content) as { end_line: number; truncated: boolean };
    expect(payload.end_line).toBe(CHAT_READ_MAX_LINES);
    expect(payload.truncated).toBe(true);
  });

  it("refuses protected and missing reads", async () => {
    const { execute } = executorWith({ files: {} });
    expect((await execute("read_file", { path: ".env" }, {})).isError).toBe(true);
    expect((await execute("read_file", { path: "missing.txt" }, {})).isError).toBe(true);
  });

  it("rejects path traversal", async () => {
    const { execute } = executorWith({});
    await expect(execute("read_file", { path: "../outside.txt" }, {})).rejects.toThrow(/traversal/);
  });

  it("writes after an allow-once decision and reports the diff to the gate", async () => {
    let seen: WritePermissionRequest | undefined;
    const { execute, workspace, gate, writes } = executorWith({
      files: { "a.txt": "old\n" },
      decision: "allow-once",
      onGate: (request) => { seen = request; }
    });
    const outcome = await execute("write_file", { path: "a.txt", content: "new\n" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(await workspace.readFile("a.txt")).toBe("new\n");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(seen?.creates).toBe(false);
    expect(seen?.diff).toContain("-old");
    expect(seen?.diff).toContain("+new");
    expect(writes).toEqual(["a.txt"]);
  });

  it("does not write on reject and tells the model not to retry", async () => {
    const { execute, workspace } = executorWith({ files: { "a.txt": "old\n" }, decision: "reject" });
    const outcome = await execute("write_file", { path: "a.txt", content: "new\n" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Do not retry");
    expect(await workspace.readFile("a.txt")).toBe("old\n");
  });

  it("skips the gate after an always-allow grant for the same file", async () => {
    const { execute, gate } = executorWith({ files: { "a.txt": "v1\n" }, decision: "always-allow" });
    await execute("write_file", { path: "a.txt", content: "v2\n" }, {});
    await execute("write_file", { path: "a.txt", content: "v3\n" }, {});
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("marks new files as creations", async () => {
    let seen: WritePermissionRequest | undefined;
    const { execute, workspace } = executorWith({ decision: "allow-once", onGate: (request) => { seen = request; } });
    const outcome = await execute("write_file", { path: "fresh.md", content: "# hi\n" }, {});
    expect(outcome.content).toContain("Created fresh.md");
    expect(seen?.creates).toBe(true);
    expect(await workspace.readFile("fresh.md")).toBe("# hi\n");
  });

  it("short-circuits identical content without prompting", async () => {
    const { execute, gate } = executorWith({ files: { "a.txt": "same\n" } });
    const outcome = await execute("write_file", { path: "a.txt", content: "same\n" }, {});
    expect(outcome.content).toContain("No change");
    expect(gate).not.toHaveBeenCalled();
  });

  it("refuses protected writes and oversized writes without prompting", async () => {
    const { execute, gate } = executorWith({});
    expect((await execute("write_file", { path: ".env", content: "x" }, {})).isError).toBe(true);
    const huge = "x".repeat(CHAT_WRITE_MAX_BYTES + 1);
    expect((await execute("write_file", { path: "big.bin", content: huge }, {})).isError).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });

  it("fails unknown tools", async () => {
    const { execute } = executorWith({});
    expect((await execute("mystery", {}, {})).isError).toBe(true);
  });
});
