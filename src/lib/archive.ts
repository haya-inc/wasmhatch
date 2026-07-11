import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { WorkspaceFile } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const BINARY_EXTENSIONS = new Set([
  "7z", "avi", "bmp", "class", "dll", "dmg", "doc", "docx", "eot", "exe", "gif",
  "gz", "ico", "jar", "jpeg", "jpg", "lockb", "mov", "mp3", "mp4", "ogg", "otf",
  "pdf", "png", "ppt", "pptx", "pyc", "rar", "so", "tar", "ttf", "wav", "webm",
  "webp", "woff", "woff2", "xls", "xlsx", "zip"
]);

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

export function isSupportedGitHubPath(path: string) {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return !BINARY_EXTENSIONS.has(extension);
}

async function githubApi<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub import failed (${response.status}).`);
  return response.json() as Promise<T>;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchGitHubRepository(input: string, ref = "HEAD") {
  const { owner, repo } = parseGitHubRepository(input);
  const repository = await githubApi<{ default_branch: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  );
  const requestedRef = ref === "HEAD" ? repository.default_branch : ref;
  const commit = await githubApi<{ sha: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(requestedRef)}`
  );
  const tree = await githubApi<{
    truncated: boolean;
    tree: Array<{ path: string; type: string; size?: number }>;
  }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit.sha}?recursive=1`
  );

  if (tree.truncated) throw new Error("The repository tree is too large for a safe browser import.");
  const entries = tree.tree.filter(
    (entry) => entry.type === "blob" && (entry.size ?? 0) <= MAX_FILE_BYTES && isSupportedGitHubPath(entry.path)
  );
  if (entries.length > MAX_FILES) throw new Error("Repository contains more than 500 supported files.");
  const totalBytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("Repository text files exceed the 20 MB import limit.");

  const prefix = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit.sha}`;
  const files = await mapWithConcurrency(entries, 8, async (entry): Promise<WorkspaceFile | null> => {
    const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${prefix}/${encodedPath}`);
    if (!response.ok) throw new Error(`Failed to fetch ${entry.path} (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isProbablyText(bytes)) return null;
    return { path: normalizeWorkspacePath(entry.path), content: strFromU8(bytes) };
  });

  return files.filter((file): file is WorkspaceFile => file !== null);
}
