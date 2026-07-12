import { parseNormalizedArtifactJson } from "./tabular-artifact-persistence";
import {
  OPERATOR_WORKSPACE_BUNDLE_LIMITS,
  operatorWorkspaceMediaTypeForPath,
  validateOperatorWorkspacePath
} from "./operator-workspace-bundle";
import type { WorkspaceStore } from "./workspace";
import { hashWorkspaceContent } from "./workspace-script";

export const OPERATOR_ARTIFACT_BROWSER_LIMITS = Object.freeze({
  previewBytes: 24 * 1024,
  previewLines: 200,
  attachmentBytes: 512 * 1024
});

export type OperatorArtifactKind = "markdown" | "csv" | "json" | "javascript" | "text";

export interface OperatorArtifactDescriptor {
  readonly path: string;
  readonly root: string;
  readonly name: string;
  readonly kind: OperatorArtifactKind;
  readonly mediaType: string;
  readonly bytes: number;
  readonly lines: number;
  readonly sha256: string;
  readonly tabularSnapshot: boolean;
}

export interface OperatorArtifactIndex {
  readonly files: readonly OperatorArtifactDescriptor[];
  readonly totalBytes: number;
}

export interface OperatorArtifactPreview {
  readonly artifact: OperatorArtifactDescriptor;
  readonly content: string;
  readonly previewBytes: number;
  readonly previewLines: number;
  readonly truncated: boolean;
}

export interface OperatorArtifactAttachment {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly tabularSnapshot: boolean;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function artifactKind(mediaType: string): OperatorArtifactKind {
  if (mediaType === "text/markdown") return "markdown";
  if (mediaType === "text/csv") return "csv";
  if (mediaType === "application/json") return "json";
  if (mediaType === "text/javascript") return "javascript";
  return "text";
}

function lineCount(content: string) {
  if (!content.length) return 0;
  return content.split("\n").length;
}

function isTabularSnapshot(path: string, content: string) {
  if (!path.startsWith("inputs/") || !path.endsWith(".json") || !content.includes("wasmhatch.tabular-snapshot.v1")) return false;
  try {
    parseNormalizedArtifactJson(content);
    return true;
  } catch {
    return false;
  }
}

function validateContent(path: string, content: string) {
  if (typeof content !== "string") throw new Error(`Operator artifact must contain text: ${path}`);
  const bytes = byteLength(content);
  if (bytes > OPERATOR_WORKSPACE_BUNDLE_LIMITS.fileBytes) throw new Error(`Operator artifact exceeds 2 MB: ${path}`);
  if (content.includes("\0")) throw new Error(`Operator artifact contains a NUL byte: ${path}`);
  return bytes;
}

async function describe(pathValue: string, content: string): Promise<OperatorArtifactDescriptor> {
  const path = validateOperatorWorkspacePath(pathValue);
  const bytes = validateContent(path, content);
  const parts = path.split("/");
  const mediaType = operatorWorkspaceMediaTypeForPath(path);
  return deepFreeze({
    path,
    root: parts[0],
    name: parts.at(-1)!,
    kind: artifactKind(mediaType),
    mediaType,
    bytes,
    lines: lineCount(content),
    sha256: await hashWorkspaceContent(content),
    tabularSnapshot: isTabularSnapshot(path, content)
  });
}

async function readDescribedArtifact(store: WorkspaceStore, pathValue: string) {
  const path = validateOperatorWorkspacePath(pathValue);
  const content = await store.readFile(path);
  return { artifact: await describe(path, content), content };
}

function boundedUtf8Prefix(content: string, maximumBytes: number) {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength <= maximumBytes) return content;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 4); end -= 1) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      // Move to the previous complete UTF-8 code point.
    }
  }
  throw new Error("Operator artifact preview could not find a UTF-8 boundary.");
}

export async function listOperatorArtifacts(store: WorkspaceStore): Promise<OperatorArtifactIndex> {
  const paths = await store.listFiles();
  if (paths.length > OPERATOR_WORKSPACE_BUNDLE_LIMITS.files) throw new Error("Operator workspace contains more than 128 files.");
  const canonical = paths.map(validateOperatorWorkspacePath).sort();
  if (new Set(canonical).size !== canonical.length) throw new Error("Operator workspace contains duplicate artifact paths.");
  if (new Set(canonical.map((path) => path.toLowerCase())).size !== canonical.length) {
    throw new Error("Operator workspace contains case-ambiguous artifact paths.");
  }
  const files: OperatorArtifactDescriptor[] = [];
  let totalBytes = 0;
  for (const path of canonical) {
    const artifact = await describe(path, await store.readFile(path));
    totalBytes += artifact.bytes;
    if (totalBytes > OPERATOR_WORKSPACE_BUNDLE_LIMITS.expandedBytes) throw new Error("Operator workspace exceeds the 8 MB artifact index limit.");
    files.push(artifact);
  }
  return deepFreeze({ files: deepFreeze(files), totalBytes });
}

export async function readOperatorArtifactPreview(store: WorkspaceStore, path: string): Promise<OperatorArtifactPreview> {
  const result = await readDescribedArtifact(store, path);
  const byteBounded = boundedUtf8Prefix(result.content, OPERATOR_ARTIFACT_BROWSER_LIMITS.previewBytes);
  const lines = byteBounded.split("\n");
  const content = lines.slice(0, OPERATOR_ARTIFACT_BROWSER_LIMITS.previewLines).join("\n");
  return deepFreeze({
    artifact: result.artifact,
    content,
    previewBytes: byteLength(content),
    previewLines: content.length ? content.split("\n").length : 0,
    truncated: content !== result.content
  });
}

export async function prepareOperatorArtifactAttachment(store: WorkspaceStore, path: string): Promise<OperatorArtifactAttachment> {
  const { artifact } = await readDescribedArtifact(store, path);
  if (artifact.bytes > OPERATOR_ARTIFACT_BROWSER_LIMITS.attachmentBytes) {
    throw new Error(`Operator artifact exceeds the 512 KB AI attachment limit: ${artifact.path}`);
  }
  return deepFreeze({
    path: artifact.path,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    tabularSnapshot: artifact.tabularSnapshot
  });
}

export async function verifyOperatorArtifactAttachment(store: WorkspaceStore, attachment: OperatorArtifactAttachment) {
  const current = await prepareOperatorArtifactAttachment(store, attachment.path);
  if (
    current.sha256 !== attachment.sha256 ||
    current.bytes !== attachment.bytes ||
    current.mediaType !== attachment.mediaType ||
    current.tabularSnapshot !== attachment.tabularSnapshot
  ) throw new Error(`Operator artifact changed after AI attachment review: ${attachment.path}`);
  return current;
}
