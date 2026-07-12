import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStore,
  formatBytes,
  inspectBrowserStorage,
  measureWorkspaceUsage,
  normalizeWorkspacePath,
  requestPersistentStorage,
  type WorkspaceStore
} from "./workspace";

class MemoryFile {
  readonly kind = "file";

  constructor(private content = "") {}

  async getFile() {
    return { text: async () => this.content };
  }

  async createWritable() {
    let next = this.content;
    return {
      write: async (value: string) => { next = value; },
      close: async () => { this.content = next; }
    };
  }
}

class MemoryDirectory {
  readonly kind = "directory";
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  failNextCreate = "";

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectory) return existing;
    if (existing) throw new DOMException("Path is a file.", "TypeMismatchError");
    if (!options.create) throw new DOMException("Directory not found.", "NotFoundError");
    if (this.failNextCreate === name) {
      this.failNextCreate = "";
      throw new DOMException("Storage is full.", "QuotaExceededError");
    }
    const directory = new MemoryDirectory();
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFile) return existing;
    if (existing) throw new DOMException("Path is a directory.", "TypeMismatchError");
    if (!options.create) throw new DOMException("File not found.", "NotFoundError");
    const file = new MemoryFile();
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException("Path not found.", "NotFoundError");
  }

  async *entries() {
    yield* this.children.entries();
  }
}

describe("normalizeWorkspacePath", () => {
  it("normalizes separators", () => {
    expect(normalizeWorkspacePath("src\\main.ts")).toBe("src/main.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => normalizeWorkspacePath("../secret")).toThrow(/traversal/i);
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow(/relative/i);
  });
});

describe("measureWorkspaceUsage", () => {
  it("counts UTF-8 content in the working tree and baseline", async () => {
    const store: WorkspaceStore = {
      backend: "opfs",
      listFiles: vi.fn().mockResolvedValue(["a.txt", "b.txt"]),
      listBaselineFiles: vi.fn().mockResolvedValue(["a.txt"]),
      readFile: vi.fn().mockImplementation(async (path) => path === "a.txt" ? "hello" : "日本"),
      readBaselineFile: vi.fn().mockResolvedValue("hi"),
      writeFile: vi.fn(),
      replaceBaseline: vi.fn(),
      replaceAll: vi.fn(),
      clear: vi.fn()
    };

    await expect(measureWorkspaceUsage(store)).resolves.toEqual({
      workingBytes: 11,
      baselineBytes: 2,
      totalBytes: 13
    });
  });
});

describe("workspace clearing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes both localStorage trees", async () => {
    const values = new Map<string, string>();
    const removeItem = vi.fn((key: string) => values.delete(key));
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem
    });
    const store = createWorkspaceStore();
    expect(store.backend).toBe("local-storage");
    await store.replaceAll([{ path: "README.md", content: "private" }]);

    await store.clear();

    await expect(store.listFiles()).resolves.toEqual([]);
    await expect(store.listBaselineFiles()).resolves.toEqual([]);
    expect(removeItem).toHaveBeenCalledTimes(2);
  });

  it("clears a never-initialized OPFS workspace without an error", async () => {
    const origin = new MemoryDirectory();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(origin) }
    });
    const store = createWorkspaceStore();
    expect(store.backend).toBe("opfs");

    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("removes both OPFS trees", async () => {
    const origin = new MemoryDirectory();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(origin) }
    });
    const store = createWorkspaceStore();
    await store.replaceAll([{ path: "README.md", content: "private" }]);

    await store.clear();

    expect(origin.children.size).toBe(0);
  });
});

describe("workspace replacement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores both localStorage trees when baseline replacement fails", async () => {
    const values = new Map<string, string>([
      ["wasmhatch-workspace-v1", JSON.stringify({ "old.ts": "working" })],
      ["wasmhatch-baseline-v1", JSON.stringify({ "old.ts": "baseline" })]
    ]);
    let failNextBaselineWrite = true;
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === "wasmhatch-baseline-v1" && value.includes("replacement") && failNextBaselineWrite) {
          failNextBaselineWrite = false;
          throw new DOMException("Storage is full.", "QuotaExceededError");
        }
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key)
    });
    const store = createWorkspaceStore();

    await expect(store.replaceAll([{ path: "new.ts", content: "replacement" }]))
      .rejects.toMatchObject({ name: "QuotaExceededError" });

    await expect(store.listFiles()).resolves.toEqual(["old.ts"]);
    await expect(store.listBaselineFiles()).resolves.toEqual(["old.ts"]);
    await expect(store.readFile("old.ts")).resolves.toBe("working");
    await expect(store.readBaselineFile("old.ts")).resolves.toBe("baseline");
  });

  it("restores both OPFS trees when baseline replacement fails", async () => {
    const origin = new MemoryDirectory();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockResolvedValue(origin) }
    });
    const store = createWorkspaceStore();
    await store.replaceAll([{ path: "old.ts", content: "original" }]);
    origin.failNextCreate = "wasmhatch-baseline";

    await expect(store.replaceAll([{ path: "new.ts", content: "replacement" }]))
      .rejects.toMatchObject({ name: "QuotaExceededError" });

    await expect(store.listFiles()).resolves.toEqual(["old.ts"]);
    await expect(store.listBaselineFiles()).resolves.toEqual(["old.ts"]);
    await expect(store.readFile("old.ts")).resolves.toBe("original");
    await expect(store.readBaselineFile("old.ts")).resolves.toBe("original");
  });
});

describe("browser storage capabilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports persistence and origin quota when supported", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persisted: vi.fn().mockResolvedValue(true),
        persist: vi.fn().mockResolvedValue(true),
        estimate: vi.fn().mockResolvedValue({ usage: 2048, quota: 8192 })
      }
    });

    await expect(inspectBrowserStorage()).resolves.toEqual({
      persistence: "persistent",
      persistenceRequestAvailable: true,
      originUsageBytes: 2048,
      quotaBytes: 8192
    });
    await expect(requestPersistentStorage()).resolves.toBe(true);
  });

  it("degrades capability reporting without a StorageManager", async () => {
    vi.stubGlobal("navigator", {});
    await expect(inspectBrowserStorage()).resolves.toEqual({
      persistence: "unsupported",
      persistenceRequestAvailable: false,
      originUsageBytes: null,
      quotaBytes: null
    });
    await expect(requestPersistentStorage()).resolves.toBeNull();
  });

  it("selects OPFS only when the directory capability exists", () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: vi.fn() } });
    expect(createWorkspaceStore().backend).toBe("opfs");
  });
});

describe("formatBytes", () => {
  it("formats compact storage values", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
  });
});
