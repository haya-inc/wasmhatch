/**
 * Pure, network-free ZIP codec for workspace text archives.
 */

import { strFromU8, strToU8, Unzip, UnzipInflate, zipSync } from "fflate";
import type { WorkspaceFile } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_PATH_BYTES = 1024;
const UNZIP_INPUT_CHUNK_BYTES = 4096;
const BINARY_EXTENSIONS = new Set([
  "7z", "avi", "bmp", "class", "dll", "dmg", "doc", "docx", "eot", "exe", "gif",
  "gz", "ico", "jar", "jpeg", "jpg", "lockb", "mov", "mp3", "mp4", "ogg", "otf",
  "pdf", "png", "ppt", "pptx", "pyc", "rar", "so", "tar", "ttf", "wav", "webm",
  "webp", "woff", "woff2", "xls", "xlsx", "zip"
]);

function isSupportedTextPath(path: string): boolean {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return !BINARY_EXTENSIONS.has(extension);
}

function isProbablyText(bytes: Uint8Array): boolean {
  // A UTF-16 byte-order mark means the UTF-8 decoder would import mojibake,
  // so treat it as binary even when the content has no NUL bytes.
  if (bytes.length >= 2 && (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  )) return false;
  return !bytes.subarray(0, 8000).includes(0);
}

class ArchiveSafetyError extends Error {}

export interface BoundedUnzipEntryInfo {
  name: string;
  declaredSize: number;
  compression: number;
}

export interface BoundedUnzipOptions<TError extends Error> {
  maxEntryBytes: (name: string) => number;
  maxTotalBytes: number;
  filter: (entry: BoundedUnzipEntryInfo) => boolean;
  onEntryLimitExceeded: (name: string) => TError;
  onTotalLimitExceeded: () => TError;
  onInvalidZip: (cause?: unknown) => TError;
  isPassThroughError: (error: unknown) => boolean;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

interface CentralEntryMeta {
  uncompressedSize: number;
  compression: number;
}

function parseCentralDirectory(bytes: Uint8Array): CentralEntryMeta[] | null {
  if (bytes.byteLength < 22) return null;
  const minEocd = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minEocd; offset -= 1) {
    if (
      readU32LE(bytes, offset) === 0x06054b50 &&
      readU16LE(bytes, offset + 20) === bytes.byteLength - offset - 22
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;
  if (readU16LE(bytes, eocd + 4) !== 0 || readU16LE(bytes, eocd + 6) !== 0) return null;
  const expectedEntries = readU16LE(bytes, eocd + 10);
  const cdSize = readU32LE(bytes, eocd + 12);
  const cdOffset = readU32LE(bytes, eocd + 16);
  if (cdOffset > eocd || cdSize > eocd - cdOffset || cdOffset + cdSize !== eocd) return null;

  const entries: CentralEntryMeta[] = [];
  let cursor = cdOffset;
  while (cursor < eocd) {
    if (cursor + 46 > eocd || readU32LE(bytes, cursor) !== 0x02014b50) return null;
    const compression = readU16LE(bytes, cursor + 10);
    const uncompressedSize = readU32LE(bytes, cursor + 24);
    const nameLen = readU16LE(bytes, cursor + 28);
    const extraLen = readU16LE(bytes, cursor + 30);
    const commentLen = readU16LE(bytes, cursor + 32);
    const localOffset = readU32LE(bytes, cursor + 42);
    if (localOffset + 30 > cdOffset || readU32LE(bytes, localOffset) !== 0x04034b50) return null;
    const nextCursor = cursor + 46 + nameLen + extraLen + commentLen;
    if (nextCursor > eocd) return null;
    entries.push({ uncompressedSize, compression });
    cursor = nextCursor;
  }
  if (cursor !== eocd) return null;
  if (expectedEntries !== 0xffff && entries.length !== expectedEntries) return null;
  return entries;
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Extracts ZIP entries using incremental streaming decompression so actual
 * expanded bytes are bounded chunk-by-chunk regardless of spoofed ZIP headers.
 */
export function unzipBoundedEntries<TError extends Error>(
  bytes: Uint8Array,
  options: BoundedUnzipOptions<TError>
): Map<string, Uint8Array> {
  const centralEntries = parseCentralDirectory(bytes);
  if (!centralEntries) throw options.onInvalidZip();

  const extracted = new Map<string, Uint8Array>();
  let totalExpandedBytes = 0;
  let entryIndex = 0;
  let completedEntries = 0;
  let acceptedEntries = 0;

  try {
    const unzipper = new Unzip((file) => {
      const central = centralEntries[entryIndex];
      entryIndex += 1;
      if (!central) throw options.onInvalidZip();
      const declaredSize = central.uncompressedSize;
      const shouldExtract = options.filter({
        name: file.name,
        declaredSize,
        compression: central.compression
      });
      if (!shouldExtract) return;
      if (central.compression !== 0 && central.compression !== 8) {
        throw options.onInvalidZip();
      }
      acceptedEntries += 1;
      const entryLimit = Math.min(options.maxEntryBytes(file.name), declaredSize);
      const chunks: Uint8Array[] = [];
      let entryBytes = 0;

      file.ondata = (err, chunk, final) => {
        if (err) {
          if (options.isPassThroughError(err)) throw err;
          throw options.onInvalidZip(err);
        }
        if (chunk.byteLength > 0) {
          entryBytes += chunk.byteLength;
          totalExpandedBytes += chunk.byteLength;
          if (entryBytes > options.maxEntryBytes(file.name)) {
            file.terminate();
            throw options.onEntryLimitExceeded(file.name);
          }
          if (totalExpandedBytes > options.maxTotalBytes) {
            file.terminate();
            throw options.onTotalLimitExceeded();
          }
          if (entryBytes > entryLimit) {
            file.terminate();
            throw options.onEntryLimitExceeded(file.name);
          }
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          chunks.push(copy);
        }
        if (final) {
          if (entryBytes !== declaredSize) {
            throw options.onInvalidZip();
          }
          extracted.set(file.name, concatChunks(chunks, entryBytes));
          completedEntries += 1;
        }
      };
      file.start();
    });
    unzipper.register(UnzipInflate);

    for (let offset = 0; offset < bytes.byteLength; offset += UNZIP_INPUT_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + UNZIP_INPUT_CHUNK_BYTES);
      unzipper.push(bytes.subarray(offset, end), end >= bytes.byteLength);
    }
    if (bytes.byteLength === 0) unzipper.push(bytes, true);
    if (entryIndex !== centralEntries.length || completedEntries !== acceptedEntries) {
      throw options.onInvalidZip();
    }
    return extracted;
  } catch (error) {
    if (options.isPassThroughError(error)) throw error;
    throw options.onInvalidZip(error);
  }
}

export function readZipArchive(bytes: Uint8Array): WorkspaceFile[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 20 MB limit.");
  const encoder = new TextEncoder();
  let fileCount = 0;
  let declaredExpandedBytes = 0;
  const validatedPaths = new Set<string>();

  const entries = unzipBoundedEntries(bytes, {
    maxEntryBytes: () => MAX_FILE_BYTES,
    maxTotalBytes: MAX_ARCHIVE_BYTES,
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      fileCount += 1;
      if (fileCount > MAX_FILES) throw new ArchiveSafetyError("Archive contains more than 500 files.");
      if (encoder.encode(file.name).byteLength > MAX_PATH_BYTES) {
        throw new ArchiveSafetyError("Archive contains a path longer than 1,024 bytes.");
      }
      let normalizedPath: string;
      try {
        normalizedPath = normalizeWorkspacePath(file.name);
      } catch {
        throw new ArchiveSafetyError("Archive contains an unsafe path.");
      }
      if (validatedPaths.has(normalizedPath)) {
        throw new ArchiveSafetyError(`Archive contains a duplicate path: ${normalizedPath}`);
      }
      validatedPaths.add(normalizedPath);
      if (!Number.isSafeInteger(file.declaredSize) || file.declaredSize < 0) {
        throw new ArchiveSafetyError("Archive contains an invalid file size.");
      }
      if (file.declaredSize > MAX_FILE_BYTES || !isSupportedTextPath(file.name)) return false;
      declaredExpandedBytes += file.declaredSize;
      if (declaredExpandedBytes > MAX_ARCHIVE_BYTES) {
        throw new ArchiveSafetyError("Archive expands beyond the 20 MB limit.");
      }
      return true;
    },
    onEntryLimitExceeded: () => new ArchiveSafetyError("Archive entry exceeds its declared size or the 2 MB limit."),
    onTotalLimitExceeded: () => new ArchiveSafetyError("Archive expands beyond the 20 MB limit."),
    onInvalidZip: () => new Error("Archive is not a valid ZIP file."),
    isPassThroughError: (error) => error instanceof ArchiveSafetyError
  });

  const names = [...entries.keys()];
  const root = names.length ? names[0].split("/")[0] : "";
  const hasSharedRoot = Boolean(root) && names.every((name) => name.startsWith(`${root}/`));
  const seen = new Set<string>();

  return names.flatMap((name) => {
    const content = entries.get(name)!;
    if (!isProbablyText(content)) return [];
    const stripped = hasSharedRoot ? name.slice(root.length + 1) : name;
    if (!stripped) return [];
    const path = normalizeWorkspacePath(stripped);
    if (seen.has(path)) throw new ArchiveSafetyError(`Archive contains a duplicate path: ${path}`);
    seen.add(path);
    return [{ path, content: strFromU8(content) }];
  });
}

export function createZipArchive(files: WorkspaceFile[]): Uint8Array {
  const archiveEntries: Record<string, Uint8Array> = Object.create(null);
  for (const file of files) {
    archiveEntries[file.path] = strToU8(file.content);
  }
  return zipSync(archiveEntries, { level: 6 });
}
