/**
 * Small async text store for cross-thread app metadata — the hatchling
 * registry, per-thread transcripts, and the ticket board.
 *
 * Backed by one OPFS directory (`wasmhatch-meta/`) so several kilobytes to a
 * few megabytes of state never compete with localStorage's tiny origin
 * budget. Where OPFS is unavailable the same interface falls back to
 * localStorage under a namespaced key prefix. Reads return null for missing
 * or unreadable entries; a corrupt entry must never break page boot.
 */

const META_ROOT = "wasmhatch-meta";
const FALLBACK_PREFIX = "wasmhatch-meta:";

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function assertKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid meta store key: ${key}`);
  return key;
}

export interface AsyncTextStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class OpfsTextStore implements AsyncTextStore {
  private async directory(): Promise<FileSystemDirectoryHandle> {
    const originRoot = await navigator.storage.getDirectory();
    return originRoot.getDirectoryHandle(META_ROOT, { create: true });
  }

  async read(key: string): Promise<string | null> {
    assertKey(key);
    try {
      const directory = await this.directory();
      const handle = await directory.getFileHandle(key);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key);
    const directory = await this.directory();
    const handle = await directory.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    await writable.write(value);
    await writable.close();
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    try {
      const directory = await this.directory();
      await directory.removeEntry(key);
    } catch {
      /* removing something already gone is success */
    }
  }
}

class LocalStorageTextStore implements AsyncTextStore {
  async read(key: string): Promise<string | null> {
    assertKey(key);
    try {
      return localStorage.getItem(FALLBACK_PREFIX + key);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key);
    localStorage.setItem(FALLBACK_PREFIX + key, value);
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    try {
      localStorage.removeItem(FALLBACK_PREFIX + key);
    } catch {
      /* nothing to remove or storage is blocked — both are fine */
    }
  }
}

/** In-memory store for tests and as a last resort when no storage exists. */
export class MemoryTextStore implements AsyncTextStore {
  private readonly values = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    assertKey(key);
    return this.values.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key);
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    this.values.delete(key);
  }
}

export function createMetaStore(): AsyncTextStore {
  if (typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage) {
    return new OpfsTextStore();
  }
  if (typeof localStorage !== "undefined") return new LocalStorageTextStore();
  return new MemoryTextStore();
}
