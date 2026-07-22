export interface WorkspaceFile {
  path: string;
  content: string;
}

export type WorkspaceBackend = "opfs" | "local-storage";

export interface WorkspaceStore {
  readonly backend: WorkspaceBackend;
  listFiles(): Promise<string[]>;
  listBaselineFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  readBaselineFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  replaceBaseline(files: WorkspaceFile[]): Promise<void>;
  replaceAll(files: WorkspaceFile[]): Promise<void>;
  clear(): Promise<void>;
}

export interface BrowserStorageStatus {
  persistence: "persistent" | "best-effort" | "unsupported";
  persistenceRequestAvailable: boolean;
  originUsageBytes: number | null;
  quotaBytes: number | null;
}

export interface WorkspaceUsage {
  workingBytes: number;
  baselineBytes: number;
  totalBytes: number;
}

const FALLBACK_KEY = "wasmhatch-workspace-v1";
const FALLBACK_BASELINE_KEY = "wasmhatch-baseline-v1";

/**
 * OPFS directory names (or localStorage key roots in the fallback) for one
 * workspace pair: the working tree and the revert baseline. Every hatchling
 * thread gets its own pair; the historical single workspace keeps the
 * original names so existing users' files stay exactly where they were.
 */
export interface WorkspaceRoots {
  working: string;
  baseline: string;
}

export const DEFAULT_WORKSPACE_ROOTS: WorkspaceRoots = Object.freeze({
  working: "wasmhatch-workspace",
  baseline: "wasmhatch-baseline"
});

const ROOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertRootName(name: string): string {
  if (!ROOT_NAME_PATTERN.test(name)) throw new Error(`Invalid workspace root name: ${name}`);
  return name;
}

export function normalizeWorkspacePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);

  if (!parts.length || input.includes("\0") || input.startsWith("/")) {
    throw new Error("Path must be workspace-relative.");
  }

  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Path traversal is not allowed.");
  }

  return parts.join("/");
}

class LocalStorageWorkspace implements WorkspaceStore {
  readonly backend = "local-storage" as const;
  private readonly workingKey: string;
  private readonly baselineKey: string;

  constructor(roots: WorkspaceRoots = DEFAULT_WORKSPACE_ROOTS) {
    // The historical single workspace keeps its original storage keys.
    this.workingKey = roots.working === DEFAULT_WORKSPACE_ROOTS.working
      ? FALLBACK_KEY
      : `wasmhatch-ws-v1:${assertRootName(roots.working)}`;
    this.baselineKey = roots.baseline === DEFAULT_WORKSPACE_ROOTS.baseline
      ? FALLBACK_BASELINE_KEY
      : `wasmhatch-bl-v1:${assertRootName(roots.baseline)}`;
  }

  private load(key = this.workingKey): Record<string, string> {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as Record<string, string>) : {};
  }

  private save(files: Record<string, string>, key = this.workingKey) {
    localStorage.setItem(key, JSON.stringify(files));
  }

  private restore(key: string, value: string | null) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }

  async listFiles() {
    return Object.keys(this.load()).sort();
  }

  async listBaselineFiles() {
    return Object.keys(this.load(this.baselineKey)).sort();
  }

  async readFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load()[normalized];
    if (content === undefined) throw new Error(`File not found: ${normalized}`);
    return content;
  }

  async readBaselineFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load(this.baselineKey)[normalized];
    if (content === undefined) throw new Error(`Baseline file not found: ${normalized}`);
    return content;
  }

  async writeFile(path: string, content: string) {
    const files = this.load();
    files[normalizeWorkspacePath(path)] = content;
    this.save(files);
  }

  async replaceAll(files: WorkspaceFile[]) {
    const next = Object.fromEntries(files.map((file) => [normalizeWorkspacePath(file.path), file.content]));
    const previousWorking = localStorage.getItem(this.workingKey);
    const previousBaseline = localStorage.getItem(this.baselineKey);
    try {
      this.save(next);
      this.save(next, this.baselineKey);
    } catch (error) {
      try {
        this.restore(this.workingKey, previousWorking);
        this.restore(this.baselineKey, previousBaseline);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Workspace replacement and rollback both failed.");
      }
      throw error;
    }
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    const next = Object.fromEntries(files.map((file) => [normalizeWorkspacePath(file.path), file.content]));
    const previous = localStorage.getItem(this.baselineKey);
    try {
      this.save(next, this.baselineKey);
    } catch (error) {
      try {
        this.restore(this.baselineKey, previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Baseline replacement and rollback both failed.");
      }
      throw error;
    }
  }

  async clear() {
    localStorage.removeItem(this.workingKey);
    localStorage.removeItem(this.baselineKey);
  }
}

class OpfsWorkspace implements WorkspaceStore {
  readonly backend = "opfs" as const;
  private readonly roots: WorkspaceRoots;

  constructor(roots: WorkspaceRoots = DEFAULT_WORKSPACE_ROOTS) {
    this.roots = { working: assertRootName(roots.working), baseline: assertRootName(roots.baseline) };
  }

  private async root(name = this.roots.working) {
    const originRoot = await navigator.storage.getDirectory();
    return originRoot.getDirectoryHandle(name, { create: true });
  }

  private async fileHandle(path: string, create = false, rootName = this.roots.working) {
    const parts = normalizeWorkspacePath(path).split("/");
    const fileName = parts.pop()!;
    let directory = await this.root(rootName);

    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create });
    }

    return directory.getFileHandle(fileName, { create });
  }

  private async listRoot(rootName: string) {
    const files: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, prefix = "") => {
      const iterableDirectory = directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of iterableDirectory.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "file") files.push(path);
        else await walk(handle, path);
      }
    };
    await walk(await this.root(rootName));
    return files.sort();
  }

  private async readRoot(rootName: string): Promise<WorkspaceFile[]> {
    const paths = await this.listRoot(rootName);
    return Promise.all(paths.map(async (path) => {
      const handle = await this.fileHandle(path, false, rootName);
      return { path, content: await (await handle.getFile()).text() };
    }));
  }

  private async removeRoot(rootName: string) {
    const originRoot = await navigator.storage.getDirectory();
    try {
      await originRoot.removeEntry(rootName, { recursive: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "name" in error && error.name === "NotFoundError")) {
        throw error;
      }
    }
  }

  private async replaceRoot(rootName: string, files: WorkspaceFile[]) {
    await this.removeRoot(rootName);
    const originRoot = await navigator.storage.getDirectory();
    await originRoot.getDirectoryHandle(rootName, { create: true });
    for (const file of files) await this.writeToRoot(file.path, file.content, rootName);
  }

  async listFiles() {
    return this.listRoot(this.roots.working);
  }

  async listBaselineFiles() {
    return this.listRoot(this.roots.baseline);
  }

  async readFile(path: string) {
    const handle = await this.fileHandle(path);
    return (await handle.getFile()).text();
  }

  async readBaselineFile(path: string) {
    const handle = await this.fileHandle(path, false, this.roots.baseline);
    return (await handle.getFile()).text();
  }

  async writeFile(path: string, content: string) {
    await this.writeToRoot(path, content, this.roots.working);
  }

  private async writeToRoot(path: string, content: string, rootName: string) {
    const handle = await this.fileHandle(path, true, rootName);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async replaceAll(files: WorkspaceFile[]) {
    const [previousWorking, previousBaseline] = await Promise.all([
      this.readRoot(this.roots.working),
      this.readRoot(this.roots.baseline)
    ]);
    try {
      await this.replaceRoot(this.roots.working, files);
      await this.replaceRoot(this.roots.baseline, files);
    } catch (error) {
      try {
        await this.replaceRoot(this.roots.working, previousWorking);
        await this.replaceRoot(this.roots.baseline, previousBaseline);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Workspace replacement and rollback both failed.");
      }
      throw error;
    }
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    const previous = await this.readRoot(this.roots.baseline);
    try {
      await this.replaceRoot(this.roots.baseline, files);
    } catch (error) {
      try {
        await this.replaceRoot(this.roots.baseline, previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Baseline replacement and rollback both failed.");
      }
      throw error;
    }
  }

  async clear() {
    // Remove the baseline first so a partial failure cannot leave an old baseline
    // paired with a newly seeded working tree on the next visit.
    await this.removeRoot(this.roots.baseline);
    await this.removeRoot(this.roots.working);
  }
}

export function createWorkspaceStore(roots: WorkspaceRoots = DEFAULT_WORKSPACE_ROOTS): WorkspaceStore {
  return "storage" in navigator && "getDirectory" in navigator.storage
    ? new OpfsWorkspace(roots)
    : new LocalStorageWorkspace(roots);
}

export async function inspectBrowserStorage(): Promise<BrowserStorageStatus> {
  const storage = "storage" in navigator ? navigator.storage : undefined;
  if (!storage) {
    return {
      persistence: "unsupported",
      persistenceRequestAvailable: false,
      originUsageBytes: null,
      quotaBytes: null
    };
  }

  const persistenceRequestAvailable = typeof storage.persist === "function";
  let persistence: BrowserStorageStatus["persistence"] = "unsupported";
  if (typeof storage.persisted === "function") {
    try {
      persistence = await storage.persisted() ? "persistent" : "best-effort";
    } catch { /* Capability reporting must not prevent workspace use. */ }
  }

  let originUsageBytes: number | null = null;
  let quotaBytes: number | null = null;
  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      originUsageBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    } catch { /* Quota estimates are optional browser metadata. */ }
  }

  return { persistence, persistenceRequestAvailable, originUsageBytes, quotaBytes };
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  const storage = "storage" in navigator ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== "function") return null;
  return storage.persist();
}

export async function measureWorkspaceUsage(store: WorkspaceStore): Promise<WorkspaceUsage> {
  const encoder = new TextEncoder();
  const measure = async (paths: string[], read: (path: string) => Promise<string>) => {
    const sizes = await Promise.all(paths.map(async (path) => encoder.encode(await read(path)).byteLength));
    return sizes.reduce((total, size) => total + size, 0);
  };
  const [workingPaths, baselinePaths] = await Promise.all([
    store.listFiles(),
    store.listBaselineFiles()
  ]);
  const [workingBytes, baselineBytes] = await Promise.all([
    measure(workingPaths, (path) => store.readFile(path)),
    measure(baselinePaths, (path) => store.readBaselineFile(path))
  ]);
  return { workingBytes, baselineBytes, totalBytes: workingBytes + baselineBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export interface SampleSeedOutcome {
  mode: "fresh" | "merged";
  written: string[];
  skipped: string[];
}

/**
 * Seed sample files without endangering existing work. An empty workspace is
 * replaced wholesale so the samples become the clean baseline; a workspace
 * that already holds files only gains the sample paths that do not exist yet,
 * and every existing file — including one sharing a sample's path — is left
 * untouched, working tree and baseline alike.
 */
export async function seedSampleFiles(
  store: WorkspaceStore,
  samples: readonly WorkspaceFile[]
): Promise<SampleSeedOutcome> {
  const existing = await store.listFiles();
  if (existing.length === 0) {
    await store.replaceAll([...samples]);
    return { mode: "fresh", written: samples.map((file) => normalizeWorkspacePath(file.path)), skipped: [] };
  }
  const existingPaths = new Set(existing);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const sample of samples) {
    const path = normalizeWorkspacePath(sample.path);
    if (existingPaths.has(path)) {
      skipped.push(path);
      continue;
    }
    await store.writeFile(path, sample.content);
    written.push(path);
  }
  return { mode: "merged", written, skipped };
}

export const sampleWorkspace: WorkspaceFile[] = [
  {
    path: "README.md",
    content: `# Tiny Hatch\n\nA tiny TypeScript greeting library.\n\n## Usage\n\n\`\`\`ts\nimport { greet } from \"./src/greet\";\nconsole.log(greet(\"Ada\"));\n\`\`\`\n`
  },
  {
    path: "src/greet.ts",
    content: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`
  },
  {
    path: "src/greet.test.ts",
    content: `import { describe, expect, it } from \"vitest\";\nimport { greet } from \"./greet\";\n\ndescribe(\"greet\", () => {\n  it(\"greets a person\", () => {\n    expect(greet(\"Ada\")).toBe(\"Hello, Ada!\");\n  });\n});\n`
  },
  {
    path: "package.json",
    content: `{"name":"tiny-hatch","private":true,"type":"module","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"^2.1.8"}}\n`
  }
];
