import type { BusinessValue } from "./business-script";
import {
  validateWorkspaceScriptManifest,
  type WorkspaceScriptManifest,
  type WorkspaceTextMediaType
} from "./workspace-script-contract";
import type { WorkspaceStore } from "./workspace";

export interface WorkspaceScriptInputSnapshot {
  workspacePath: string;
  mountPath: string;
  mediaType: WorkspaceTextMediaType;
  content: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceScriptOutputBase {
  workspacePath: string;
  mountPath: string;
  mediaType: WorkspaceTextMediaType;
  maxBytes: number;
  required: boolean;
  before: string | null;
  baseSha256: string;
}

export interface WorkspaceScriptRunSnapshot {
  schemaVersion: 1;
  runId: string;
  manifest: WorkspaceScriptManifest;
  manifestPath: string;
  manifestSha256: string;
  source: string;
  sourceBytes: number;
  sourceSha256: string;
  args: BusinessValue;
  argsBytes: number;
  inputs: readonly WorkspaceScriptInputSnapshot[];
  outputBases: readonly WorkspaceScriptOutputBase[];
}

const HASH_PREFIX = "sha256:";
const MISSING_HASH = "missing";
const MAX_ARGS_BYTES = 64 * 1024;

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function serializeJson(value: unknown, label: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable.`);
  return serialized;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Workspace script identity contains a non-JSON value.");
}

async function sha256Bytes(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this browser.");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashWorkspaceContent(content: string) {
  return `${HASH_PREFIX}${await sha256Bytes(new TextEncoder().encode(content))}`;
}

async function hashIdentity(value: unknown) {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export async function prepareWorkspaceScriptRun(
  store: WorkspaceStore,
  manifestValue: WorkspaceScriptManifest,
  args: BusinessValue = null
): Promise<WorkspaceScriptRunSnapshot> {
  const manifest = validateWorkspaceScriptManifest(manifestValue);
  const paths = new Set(await store.listFiles());
  const manifestPath = workspaceScriptDefinitionPath(manifest);
  if (!paths.has(manifestPath)) throw new Error(`Workspace script manifest is missing: ${manifestPath}`);
  if (!paths.has(manifest.sourcePath)) throw new Error(`Workspace script source is missing: ${manifest.sourcePath}`);
  for (const input of manifest.inputs) {
    if (!paths.has(input.workspacePath)) throw new Error(`Granted script input is missing: ${input.workspacePath}`);
  }

  const argsJson = serializeJson(args, "Workspace script args");
  const argsBytes = byteLength(argsJson);
  if (argsBytes > MAX_ARGS_BYTES) throw new Error("Workspace script args exceed 64 KB.");

  const manifestContent = await store.readFile(manifestPath);
  if (byteLength(manifestContent) > 32 * 1024) throw new Error("Workspace script manifest exceeds 32 KB.");
  let persistedManifest: WorkspaceScriptManifest;
  try {
    persistedManifest = validateWorkspaceScriptManifest(JSON.parse(manifestContent));
  } catch {
    throw new Error(`Workspace script manifest is invalid: ${manifestPath}`);
  }
  if (JSON.stringify(persistedManifest) !== JSON.stringify(manifest)) {
    throw new Error("The persisted workspace script manifest does not match the requested manifest.");
  }
  const manifestSha256 = await hashWorkspaceContent(manifestContent);

  const source = await store.readFile(manifest.sourcePath);
  const sourceBytes = byteLength(source);
  if (!source.trim()) throw new Error("Workspace script source is empty.");
  if (sourceBytes > manifest.limits.maxSourceBytes) {
    throw new Error(`Workspace script source exceeds ${manifest.limits.maxSourceBytes} bytes.`);
  }
  const sourceSha256 = await hashWorkspaceContent(source);

  const inputs = await Promise.all(manifest.inputs.map(async (grant): Promise<WorkspaceScriptInputSnapshot> => {
    const content = await store.readFile(grant.workspacePath);
    const bytes = byteLength(content);
    if (bytes > grant.maxBytes) {
      throw new Error(`Granted input ${grant.workspacePath} exceeds its ${grant.maxBytes}-byte limit.`);
    }
    return {
      workspacePath: grant.workspacePath,
      mountPath: grant.mountPath,
      mediaType: grant.mediaType,
      content,
      bytes,
      sha256: await hashWorkspaceContent(content)
    };
  }));
  const totalInputBytes = inputs.reduce((total, input) => total + input.bytes, 0);
  if (totalInputBytes > manifest.limits.maxTotalInputBytes) {
    throw new Error(`Granted inputs exceed the ${manifest.limits.maxTotalInputBytes}-byte total limit.`);
  }

  const outputBases = await Promise.all(manifest.outputs.map(async (grant): Promise<WorkspaceScriptOutputBase> => {
    const before = paths.has(grant.workspacePath) ? await store.readFile(grant.workspacePath) : null;
    if (before !== null && byteLength(before) > grant.maxBytes) {
      throw new Error(`Existing output ${grant.workspacePath} exceeds its ${grant.maxBytes}-byte review limit.`);
    }
    return {
      workspacePath: grant.workspacePath,
      mountPath: grant.mountPath,
      mediaType: grant.mediaType,
      maxBytes: grant.maxBytes,
      required: grant.required,
      before,
      baseSha256: before === null ? MISSING_HASH : await hashWorkspaceContent(before)
    };
  }));

  const identity = {
    schemaVersion: 1,
    manifest,
    manifestPath,
    manifestSha256,
    sourceSha256,
    args,
    inputs: inputs.map(({ workspacePath, mountPath, mediaType, bytes, sha256 }) => ({
      workspacePath, mountPath, mediaType, bytes, sha256
    })),
    outputs: outputBases.map(({ workspacePath, mountPath, mediaType, maxBytes, required, baseSha256 }) => ({
      workspacePath, mountPath, mediaType, maxBytes, required, baseSha256
    }))
  };
  return deepFreeze({
    schemaVersion: 1,
    runId: `run_${await hashIdentity(identity)}`,
    manifest,
    manifestPath,
    manifestSha256,
    source,
    sourceBytes,
    sourceSha256,
    args: JSON.parse(argsJson) as BusinessValue,
    argsBytes,
    inputs,
    outputBases
  });
}

export function workspaceScriptDefinitionPath(manifest: WorkspaceScriptManifest) {
  return `workflows/${manifest.id}.json`;
}
