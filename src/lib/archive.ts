import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { WorkspaceFile } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;

function isProbablyText(bytes: Uint8Array) {
  return !bytes.subarray(0, 8000).includes(0);
}

export function readZipArchive(bytes: Uint8Array): WorkspaceFile[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 20 MB limit.");
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  if (names.length > MAX_FILES) throw new Error("Archive contains more than 500 files.");

  const root = names.length ? names[0].split("/")[0] : "";
  const hasSharedRoot = Boolean(root) && names.every((name) => name.startsWith(`${root}/`));

  return names.flatMap((name) => {
    const content = entries[name];
    if (content.byteLength > MAX_FILE_BYTES || !isProbablyText(content)) return [];
    const stripped = hasSharedRoot ? name.slice(root.length + 1) : name;
    if (!stripped) return [];
    return [{ path: normalizeWorkspacePath(stripped), content: strFromU8(content) }];
  });
}

export function createZipArchive(files: WorkspaceFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((file) => [file.path, strToU8(file.content)])), {
    level: 6
  });
}

export function parseGitHubRepository(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/, "");
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)\/?$/i);
  if (!match) throw new Error("Use owner/repository or a GitHub repository URL.");
  return { owner: match[1], repo: match[2] };
}

export async function fetchGitHubRepository(input: string, ref = "HEAD") {
  const { owner, repo } = parseGitHubRepository(input);
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (!response.ok) throw new Error(`GitHub import failed (${response.status}).`);
  return readZipArchive(new Uint8Array(await response.arrayBuffer()));
}
