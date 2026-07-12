import { normalizeWorkspacePath, type WorkspaceFile, type WorkspaceStore } from "./workspace";

export const OPERATOR_WORKSPACE_ROOT = "wasmhatch-operator-workspace-v1";
export const OPERATOR_WORKSPACE_BASELINE_ROOT = "wasmhatch-operator-baseline-v1";

const OPERATOR_WORKSPACE_FALLBACK_KEY = "wasmhatch-operator-workspace-v1";
const OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY = "wasmhatch-operator-baseline-v1";

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "NotFoundError");
}

function normalizeFiles(files: readonly WorkspaceFile[]) {
  const seen = new Set<string>();
  return files.map((file) => {
    const path = normalizeWorkspacePath(file.path);
    if (seen.has(path)) throw new Error(`Operator workspace contains a duplicate path: ${path}`);
    if (typeof file.content !== "string") throw new Error(`Operator workspace file must contain text: ${path}`);
    seen.add(path);
    return { path, content: file.content };
  });
}

class LocalOperatorWorkspace implements WorkspaceStore {
  readonly backend = "local-storage" as const;

  private load(key: string) {
    const saved = localStorage.getItem(key);
    if (!saved) return {} as Record<string, string>;
    let value: unknown;
    try {
      value = JSON.parse(saved);
    } catch {
      throw new Error("Operator workspace fallback storage contains invalid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Operator workspace fallback storage is invalid.");
    }
    const files: Record<string, string> = {};
    for (const [rawPath, content] of Object.entries(value)) {
      const path = normalizeWorkspacePath(rawPath);
      if (path !== rawPath || typeof content !== "string") {
        throw new Error("Operator workspace fallback storage contains an invalid file.");
      }
      files[path] = content;
    }
    return files;
  }

  private save(key: string, files: readonly WorkspaceFile[]) {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(normalizeFiles(files).map((file) => [file.path, file.content]))));
  }

  async listFiles() {
    return Object.keys(this.load(OPERATOR_WORKSPACE_FALLBACK_KEY)).sort();
  }

  async listBaselineFiles() {
    return Object.keys(this.load(OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY)).sort();
  }

  async readFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load(OPERATOR_WORKSPACE_FALLBACK_KEY)[normalized];
    if (content === undefined) throw new Error(`Operator workspace file not found: ${normalized}`);
    return content;
  }

  async readBaselineFile(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const content = this.load(OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY)[normalized];
    if (content === undefined) throw new Error(`Operator workspace baseline file not found: ${normalized}`);
    return content;
  }

  async writeFile(path: string, content: string) {
    const files = this.load(OPERATOR_WORKSPACE_FALLBACK_KEY);
    files[normalizeWorkspacePath(path)] = content;
    this.save(OPERATOR_WORKSPACE_FALLBACK_KEY, Object.entries(files).map(([filePath, fileContent]) => ({ path: filePath, content: fileContent })));
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    this.save(OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY, files);
  }

  async replaceAll(files: WorkspaceFile[]) {
    const normalized = normalizeFiles(files);
    this.save(OPERATOR_WORKSPACE_FALLBACK_KEY, normalized);
    this.save(OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY, normalized);
  }

  async clear() {
    localStorage.removeItem(OPERATOR_WORKSPACE_FALLBACK_KEY);
    localStorage.removeItem(OPERATOR_WORKSPACE_BASELINE_FALLBACK_KEY);
  }
}

class OpfsOperatorWorkspace implements WorkspaceStore {
  readonly backend = "opfs" as const;

  private async root(name: string, create = true) {
    const originRoot = await navigator.storage.getDirectory();
    return originRoot.getDirectoryHandle(name, { create });
  }

  private async fileHandle(path: string, create: boolean, rootName: string) {
    const parts = normalizeWorkspacePath(path).split("/");
    const fileName = parts.pop()!;
    let directory = await this.root(rootName, create);
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(fileName, { create });
  }

  private async listRoot(rootName: string) {
    const files: string[] = [];
    let root: FileSystemDirectoryHandle;
    try {
      root = await this.root(rootName, false);
    } catch (error) {
      if (isNotFoundError(error)) return files;
      throw error;
    }
    const walk = async (directory: FileSystemDirectoryHandle, prefix = "") => {
      for await (const [name, handle] of (directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "file") files.push(path);
        else await walk(handle as FileSystemDirectoryHandle, path);
      }
    };
    await walk(root);
    return files.sort();
  }

  private async writeToRoot(path: string, content: string, rootName: string) {
    const handle = await this.fileHandle(path, true, rootName);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  private async replaceRoot(rootName: string, files: readonly WorkspaceFile[]) {
    const normalized = normalizeFiles(files);
    const originRoot = await navigator.storage.getDirectory();
    try {
      await originRoot.removeEntry(rootName, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await originRoot.getDirectoryHandle(rootName, { create: true });
    for (const file of normalized) await this.writeToRoot(file.path, file.content, rootName);
  }

  async listFiles() {
    return this.listRoot(OPERATOR_WORKSPACE_ROOT);
  }

  async listBaselineFiles() {
    return this.listRoot(OPERATOR_WORKSPACE_BASELINE_ROOT);
  }

  async readFile(path: string) {
    const handle = await this.fileHandle(path, false, OPERATOR_WORKSPACE_ROOT);
    return (await handle.getFile()).text();
  }

  async readBaselineFile(path: string) {
    const handle = await this.fileHandle(path, false, OPERATOR_WORKSPACE_BASELINE_ROOT);
    return (await handle.getFile()).text();
  }

  async writeFile(path: string, content: string) {
    await this.writeToRoot(path, content, OPERATOR_WORKSPACE_ROOT);
  }

  async replaceBaseline(files: WorkspaceFile[]) {
    await this.replaceRoot(OPERATOR_WORKSPACE_BASELINE_ROOT, files);
  }

  async replaceAll(files: WorkspaceFile[]) {
    const normalized = normalizeFiles(files);
    await this.replaceRoot(OPERATOR_WORKSPACE_ROOT, normalized);
    await this.replaceRoot(OPERATOR_WORKSPACE_BASELINE_ROOT, normalized);
  }

  async clear() {
    const originRoot = await navigator.storage.getDirectory();
    for (const rootName of [OPERATOR_WORKSPACE_BASELINE_ROOT, OPERATOR_WORKSPACE_ROOT]) {
      try {
        await originRoot.removeEntry(rootName, { recursive: true });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }
}

export function createOperatorWorkspaceStore(): WorkspaceStore {
  return "storage" in navigator && typeof navigator.storage.getDirectory === "function"
    ? new OpfsOperatorWorkspace()
    : new LocalOperatorWorkspace();
}
