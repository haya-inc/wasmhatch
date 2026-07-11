export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface WorkspaceStore {
  listFiles(): Promise<string[]>;
  listBaselineFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  readBaselineFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  replaceBaseline(files: WorkspaceFile[]): Promise<void>;
  replaceAll(files: WorkspaceFile[]): Promise<void>;
}

const FALLBACK_KEY = "wasmhatch-workspace-v1";
const FALLBACK_BASELINE_KEY = "wasmhatch-baseline-v1";

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
  private load(key = FALLBACK_KEY): Record<string, string> {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as Record<string, string>) : {};
  }

  private save(files: Record<string, string>, key = FALLBACK_KEY) {
    localStorage.setItem(key, JSON.stringify(files));
  }

  async listFiles() {
    return Object.keys(this.load()).sort();
  }

  async listBaselineFiles() {
    return Object.keys(this.load(FALLBACK_BASELINE_KEY)).sort();
  }

  async readFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load()[normalized];
    if (content === undefined) throw new Error(`File not found: ${normalized}`);
    return content;
  }

  async readBaselineFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load(FALLBACK_BASELINE_KEY)[normalized];
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
    this.save(next);
    this.save(next, FALLBACK_BASELINE_KEY);
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    const next = Object.fromEntries(files.map((file) => [normalizeWorkspacePath(file.path), file.content]));
    this.save(next, FALLBACK_BASELINE_KEY);
  }
}

class OpfsWorkspace implements WorkspaceStore {
  private async root(name = "wasmhatch-workspace") {
    const originRoot = await navigator.storage.getDirectory();
    return originRoot.getDirectoryHandle(name, { create: true });
  }

  private async fileHandle(path: string, create = false, rootName = "wasmhatch-workspace") {
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

  async listFiles() {
    return this.listRoot("wasmhatch-workspace");
  }

  async listBaselineFiles() {
    return this.listRoot("wasmhatch-baseline");
  }

  async readFile(path: string) {
    const handle = await this.fileHandle(path);
    return (await handle.getFile()).text();
  }

  async readBaselineFile(path: string) {
    const handle = await this.fileHandle(path, false, "wasmhatch-baseline");
    return (await handle.getFile()).text();
  }

  async writeFile(path: string, content: string) {
    await this.writeToRoot(path, content, "wasmhatch-workspace");
  }

  private async writeToRoot(path: string, content: string, rootName: string) {
    const handle = await this.fileHandle(path, true, rootName);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async replaceAll(files: WorkspaceFile[]) {
    const originRoot = await navigator.storage.getDirectory();
    await originRoot.removeEntry("wasmhatch-workspace", { recursive: true }).catch(() => undefined);
    await originRoot.getDirectoryHandle("wasmhatch-workspace", { create: true });
    for (const file of files) {
      await this.writeToRoot(file.path, file.content, "wasmhatch-workspace");
    }
    await this.replaceBaseline(files);
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    const originRoot = await navigator.storage.getDirectory();
    await originRoot.removeEntry("wasmhatch-baseline", { recursive: true }).catch(() => undefined);
    await originRoot.getDirectoryHandle("wasmhatch-baseline", { create: true });
    for (const file of files) {
      await this.writeToRoot(file.path, file.content, "wasmhatch-baseline");
    }
  }
}

export function createWorkspaceStore(): WorkspaceStore {
  return "storage" in navigator && "getDirectory" in navigator.storage
    ? new OpfsWorkspace()
    : new LocalStorageWorkspace();
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
