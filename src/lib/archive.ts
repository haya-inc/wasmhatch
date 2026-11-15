/**
 * Pure, network-free ZIP codec for workspace text archives.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { WorkspaceFile } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_PATH_BYTES = 1024;
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

export function readZipArchive(bytes: Uint8Array): WorkspaceFile[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 20 MB limit.");
  const encoder = new TextEncoder();
  let fileCount = 0;
  let expandedBytes = 0;
  const validatedPaths = new Set<string>();

  try {
    const entries = unzipSync(bytes, {
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
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          throw new ArchiveSafetyError("Archive contains an invalid file size.");
        }
        if (file.originalSize > MAX_FILE_BYTES || !isSupportedTextPath(file.name)) return false;
        expandedBytes += file.originalSize;
        if (expandedBytes > MAX_ARCHIVE_BYTES) {
          throw new ArchiveSafetyError("Archive expands beyond the 20 MB limit.");
        }
        return true;
      }
    });
    const names = Object.keys(entries);
    const root = names.length ? names[0].split("/")[0] : "";
    const hasSharedRoot = Boolean(root) && names.every((name) => name.startsWith(`${root}/`));
    const seen = new Set<string>();

    return names.flatMap((name) => {
      const content = entries[name];
      if (!isProbablyText(content)) return [];
      const stripped = hasSharedRoot ? name.slice(root.length + 1) : name;
      if (!stripped) return [];
      const path = normalizeWorkspacePath(stripped);
      if (seen.has(path)) throw new ArchiveSafetyError(`Archive contains a duplicate path: ${path}`);
      seen.add(path);
      return [{ path, content: strFromU8(content) }];
    });
  } catch (error) {
    if (error instanceof ArchiveSafetyError) throw error;
    throw new Error("Archive is not a valid ZIP file.");
  }
}

export function createZipArchive(files: WorkspaceFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((file) => [file.path, strToU8(file.content)])), {
    level: 6
  });
}
