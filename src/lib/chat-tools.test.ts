import { describe, expect, it, vi } from "vitest";
import { executeBusinessScript, type BusinessValue } from "./business-script";
import { SessionPermissionStore, type PermissionDecision, type WritePermissionRequest } from "./chat-permissions";
import {
  CHAT_READ_MAX_BYTES,
  CHAT_READ_MAX_LINES,
  CHAT_SCRIPT_LIMITS,
  CHAT_WRITE_MAX_BYTES,
  createChatToolExecutor,
  type AppliedWrite,
  type WritePolicy
} from "./chat-tools";
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
  policy?: WritePolicy;
  onGate?: (request: WritePermissionRequest) => void;
}) {
  const workspace = memoryWorkspace(options.files);
  const permissions = new SessionPermissionStore();
  const gate = vi.fn(async (request: WritePermissionRequest) => {
    options.onGate?.(request);
    return options.decision ?? "allow-once";
  });
  const writes: string[] = [];
  const applied: AppliedWrite[] = [];
  // The real QuickJS engine, run directly: the worker wrapper is a browser concern.
  const runScript = vi.fn((source: string, input: BusinessValue) =>
    executeBusinessScript(source, input, CHAT_SCRIPT_LIMITS)
  );
  const execute = createChatToolExecutor({
    workspace,
    permissions,
    gate,
    policy: () => options.policy ?? "careful",
    onWrite: (path) => writes.push(path),
    onAppliedWrite: (write) => applied.push(write),
    runScript
  });
  return { workspace, permissions, gate, execute, writes, applied, runScript };
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

describe("autonomous write policy", () => {
  it("writes immediately without prompting and reports the applied diff", async () => {
    const { execute, workspace, gate, applied } = executorWith({
      files: { "a.txt": "old\n" },
      policy: "autonomous"
    });
    const outcome = await execute("write_file", { path: "a.txt", content: "new\n" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain("revertible");
    expect(gate).not.toHaveBeenCalled();
    expect(await workspace.readFile("a.txt")).toBe("new\n");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ path: "a.txt", creates: false, before: "old\n", policy: "autonomous" });
    expect(applied[0].diff).toContain("-old");
    expect(applied[0].diff).toContain("+new");
  });

  it("is the default when no policy callback is supplied", async () => {
    const workspace = memoryWorkspace({ "a.txt": "v1\n" });
    const gate = vi.fn(async (): Promise<PermissionDecision> => "reject");
    const execute = createChatToolExecutor({ workspace, permissions: new SessionPermissionStore(), gate });
    const outcome = await execute("write_file", { path: "a.txt", content: "v2\n" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(gate).not.toHaveBeenCalled();
    expect(await workspace.readFile("a.txt")).toBe("v2\n");
  });

  it("still refuses protected paths and oversized writes", async () => {
    const { execute, gate } = executorWith({ policy: "autonomous" });
    expect((await execute("write_file", { path: ".env", content: "x" }, {})).isError).toBe(true);
    const huge = "x".repeat(CHAT_WRITE_MAX_BYTES + 1);
    expect((await execute("write_file", { path: "big.bin", content: huge }, {})).isError).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });

  it("reports careful-mode writes through onAppliedWrite as well", async () => {
    const { execute, applied } = executorWith({
      files: { "a.txt": "old\n" },
      policy: "careful",
      decision: "allow-once"
    });
    await execute("write_file", { path: "a.txt", content: "new\n" }, {});
    expect(applied).toHaveLength(1);
    expect(applied[0].policy).toBe("careful");
  });
});

describe("run_script", () => {
  it("computes over requested workspace files in the sandbox", async () => {
    const { execute, runScript } = executorWith({
      files: { "data.csv": "a,b\n1,2\n3,4\n" },
      policy: "autonomous"
    });
    const outcome = await execute("run_script", {
      script: `(input) => {
        const rows = input.files[0].content.trim().split("\\n").slice(1);
        return { sum: rows.reduce((total, row) => total + row.split(",").reduce((t, cell) => t + Number(cell), 0), 0) };
      }`,
      input_paths: ["data.csv"]
    }, {});
    expect(outcome.isError).toBeFalsy();
    const payload = JSON.parse(outcome.content) as { result: { sum: number }; duration_ms: number };
    expect(payload.result).toEqual({ sum: 10 });
    expect(payload.duration_ms).toBeGreaterThan(0);
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it("passes args through as input.args", async () => {
    const { execute } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", {
      script: "(input) => input.args.x * 2",
      args: { x: 21 }
    }, {});
    expect(JSON.parse(outcome.content).result).toBe(42);
  });

  it("writes the result through the normal write pipeline when output_path is set", async () => {
    const { execute, workspace, applied } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", {
      script: "(input) => ({ total: 3 })",
      output_path: "outputs/result.json"
    }, {});
    expect(outcome.isError).toBeFalsy();
    const payload = JSON.parse(outcome.content) as { written: string };
    expect(payload.written).toBe("outputs/result.json");
    expect(await workspace.readFile("outputs/result.json")).toBe("{\n  \"total\": 3\n}\n");
    expect(applied).toHaveLength(1);
    expect(applied[0].creates).toBe(true);
  });

  it("writes string results verbatim", async () => {
    const { execute, workspace } = executorWith({ policy: "autonomous" });
    await execute("run_script", {
      script: "() => \"plain text\"",
      output_path: "note.txt"
    }, {});
    expect(await workspace.readFile("note.txt")).toBe("plain text");
  });

  it("keeps careful mode in charge of script writes", async () => {
    const { execute, workspace, gate } = executorWith({ policy: "careful", decision: "reject" });
    const outcome = await execute("run_script", {
      script: "() => \"blocked\"",
      output_path: "blocked.txt"
    }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("the write was not applied");
    expect(gate).toHaveBeenCalledTimes(1);
    await expect(workspace.readFile("blocked.txt")).rejects.toThrow();
  });

  it("refuses protected input and output paths before running anything", async () => {
    const { execute, runScript } = executorWith({ files: { ".env": "SECRET=1" }, policy: "autonomous" });
    expect((await execute("run_script", { script: "() => 1", input_paths: [".env"] }, {})).isError).toBe(true);
    expect((await execute("run_script", { script: "() => 1", output_path: ".env" }, {})).isError).toBe(true);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("fails on missing input files", async () => {
    const { execute } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", { script: "() => 1", input_paths: ["missing.csv"] }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("File not found");
  });

  it("surfaces sandbox rejections for non-function scripts", async () => {
    const { execute } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", { script: "42" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("must evaluate to a function");
  });

  it("stops runaway scripts at the CPU deadline", async () => {
    const { execute } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", { script: "() => { while (true) {} }" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("execution time limit");
  });

  it("rejects outputs above the sandbox I/O cap", async () => {
    const { execute } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", { script: "() => \"x\".repeat(600000)" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("output exceeds");
  });

  it("truncates large results for the model while keeping the full file write", async () => {
    const { execute, workspace } = executorWith({ policy: "autonomous" });
    const outcome = await execute("run_script", {
      script: "() => \"y\".repeat(400000)",
      output_path: "big.txt"
    }, {});
    expect(outcome.isError).toBeFalsy();
    const payload = JSON.parse(outcome.content) as { result_preview: string; truncated: boolean; written: string };
    expect(payload.truncated).toBe(true);
    expect(payload.written).toBe("big.txt");
    expect(payload.result_preview.length).toBeLessThan(400000);
    expect(new TextEncoder().encode(payload.result_preview).byteLength).toBeLessThanOrEqual(CHAT_READ_MAX_BYTES);
    expect((await workspace.readFile("big.txt")).length).toBe(400000);
  });
});
