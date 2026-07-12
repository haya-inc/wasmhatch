import { normalizeWorkspacePath } from "./workspace";

export const WORKSPACE_SCRIPT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const WORKSPACE_SCRIPT_DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 750,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxSourceBytes: 24 * 1024,
  maxTotalInputBytes: 512 * 1024,
  maxTotalOutputBytes: 512 * 1024,
  maxResultBytes: 64 * 1024
});

export type WorkspaceTextMediaType =
  | "application/json"
  | "text/csv"
  | "text/markdown"
  | "text/plain";

export interface WorkspaceScriptInputGrant {
  workspacePath: string;
  mountPath: string;
  mediaType: WorkspaceTextMediaType;
  maxBytes: number;
}

export interface WorkspaceScriptOutputGrant {
  workspacePath: string;
  mountPath: string;
  mediaType: WorkspaceTextMediaType;
  maxBytes: number;
  required: boolean;
}

export interface WorkspaceScriptLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxSourceBytes: number;
  maxTotalInputBytes: number;
  maxTotalOutputBytes: number;
  maxResultBytes: number;
}

export interface WorkspaceScriptManifest {
  schemaVersion: typeof WORKSPACE_SCRIPT_MANIFEST_SCHEMA_VERSION;
  id: string;
  version: string;
  sourcePath: string;
  inputs: readonly WorkspaceScriptInputGrant[];
  outputs: readonly WorkspaceScriptOutputGrant[];
  limits: WorkspaceScriptLimits;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MEDIA_TYPES = new Set<WorkspaceTextMediaType>([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain"
]);
const PROTECTED_SEGMENTS = new Set([
  ".aws", ".azure", ".gnupg", ".ssh", "credentials", "secrets"
]);

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireString(value: unknown, label: string, maxLength = 256) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters.`);
  return normalized;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function requireWorkspacePath(value: unknown, label: string) {
  const path = normalizeWorkspacePath(requireString(value, label, 512));
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (
    segments.some((segment) => PROTECTED_SEGMENTS.has(segment)) ||
    segments.some((segment) => segment === ".env" || segment.startsWith(".env.")) ||
    /(?:^|\/)(?:id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i.test(path)
  ) {
    throw new Error(`${label} targets a protected credential path.`);
  }
  return path;
}

function requireMountPath(value: unknown, prefix: "/inputs/" | "/outputs/", label: string) {
  const path = requireString(value, label, 512);
  if (!path.startsWith(prefix) || path.includes("\\") || path.includes("//")) {
    throw new Error(`${label} must be a normalized ${prefix} path.`);
  }
  const parts = path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  return path;
}

function requireMediaType(value: unknown, label: string) {
  if (typeof value !== "string" || !MEDIA_TYPES.has(value as WorkspaceTextMediaType)) {
    throw new Error(`${label} is not a supported text media type.`);
  }
  return value as WorkspaceTextMediaType;
}

function validateInput(value: unknown, index: number): WorkspaceScriptInputGrant {
  const label = `Script input ${index + 1}`;
  assertRecord(value, label);
  assertExactKeys(value, ["workspacePath", "mountPath", "mediaType", "maxBytes"], label);
  const workspacePath = requireWorkspacePath(value.workspacePath, `${label} workspace path`);
  if (!/^(?:inputs|work|outputs)\//.test(workspacePath)) {
    throw new Error(`${label} must read from inputs/, work/, or outputs/.`);
  }
  return {
    workspacePath,
    mountPath: requireMountPath(value.mountPath, "/inputs/", `${label} mount path`),
    mediaType: requireMediaType(value.mediaType, `${label} media type`),
    maxBytes: requireInteger(value.maxBytes, `${label} byte limit`, 1, 512 * 1024)
  };
}

function validateOutput(value: unknown, index: number): WorkspaceScriptOutputGrant {
  const label = `Script output ${index + 1}`;
  assertRecord(value, label);
  assertExactKeys(value, ["workspacePath", "mountPath", "mediaType", "maxBytes", "required"], label);
  const workspacePath = requireWorkspacePath(value.workspacePath, `${label} workspace path`);
  if (!workspacePath.startsWith("outputs/")) throw new Error(`${label} must write under outputs/.`);
  if (typeof value.required !== "boolean") throw new Error(`${label} required must be boolean.`);
  return {
    workspacePath,
    mountPath: requireMountPath(value.mountPath, "/outputs/", `${label} mount path`),
    mediaType: requireMediaType(value.mediaType, `${label} media type`),
    maxBytes: requireInteger(value.maxBytes, `${label} byte limit`, 1, 512 * 1024),
    required: value.required
  };
}

function validateLimits(value: unknown): WorkspaceScriptLimits {
  assertRecord(value, "Script limits");
  assertExactKeys(value, [
    "timeoutMs",
    "memoryLimitBytes",
    "maxSourceBytes",
    "maxTotalInputBytes",
    "maxTotalOutputBytes",
    "maxResultBytes"
  ], "Script limits");
  return {
    timeoutMs: requireInteger(value.timeoutMs, "Script timeout", 50, 2_000),
    memoryLimitBytes: requireInteger(value.memoryLimitBytes, "Script memory limit", 4 * 1024 * 1024, 64 * 1024 * 1024),
    maxSourceBytes: requireInteger(value.maxSourceBytes, "Script source limit", 256, 24 * 1024),
    maxTotalInputBytes: requireInteger(value.maxTotalInputBytes, "Script total input limit", 1, 512 * 1024),
    maxTotalOutputBytes: requireInteger(value.maxTotalOutputBytes, "Script total output limit", 1, 512 * 1024),
    maxResultBytes: requireInteger(value.maxResultBytes, "Script result limit", 1, 64 * 1024)
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function validateWorkspaceScriptManifest(value: unknown): WorkspaceScriptManifest {
  assertRecord(value, "Workspace script manifest");
  assertExactKeys(value, ["schemaVersion", "id", "version", "sourcePath", "inputs", "outputs", "limits"], "Workspace script manifest");
  if (value.schemaVersion !== WORKSPACE_SCRIPT_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Workspace script manifest schema is unsupported.");
  }
  const id = requireString(value.id, "Workspace script ID", 128);
  if (!ID_PATTERN.test(id)) throw new Error("Workspace script ID must use lower-case kebab syntax.");
  const version = requireString(value.version, "Workspace script version", 64);
  if (!SEMVER_PATTERN.test(version)) throw new Error("Workspace script version must use semantic version syntax.");
  const sourcePath = requireWorkspacePath(value.sourcePath, "Workspace script source path");
  if (!sourcePath.startsWith("scripts/") || !sourcePath.endsWith(".js")) {
    throw new Error("Workspace script source must be a .js file under scripts/.");
  }
  if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 32) {
    throw new Error("Workspace scripts require 1 to 32 input grants.");
  }
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 16) {
    throw new Error("Workspace scripts require 1 to 16 output grants.");
  }
  const inputs = value.inputs.map(validateInput);
  const outputs = value.outputs.map(validateOutput);
  const unique = (items: readonly string[], label: string) => {
    if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates.`);
  };
  unique(inputs.map((input) => input.workspacePath), "Workspace script input paths");
  unique(inputs.map((input) => input.mountPath), "Workspace script input mounts");
  unique(outputs.map((output) => output.workspacePath), "Workspace script output paths");
  unique(outputs.map((output) => output.mountPath), "Workspace script output mounts");
  const limits = validateLimits(value.limits);
  if (inputs.reduce((total, input) => total + input.maxBytes, 0) < limits.maxTotalInputBytes) {
    throw new Error("Total input limit cannot exceed the sum of per-input limits.");
  }
  if (outputs.reduce((total, output) => total + output.maxBytes, 0) < limits.maxTotalOutputBytes) {
    throw new Error("Total output limit cannot exceed the sum of per-output limits.");
  }
  const manifest = { schemaVersion: 1 as const, id, version, sourcePath, inputs, outputs, limits };
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 32 * 1024) {
    throw new Error("Workspace script manifest exceeds 32 KB.");
  }
  return deepFreeze(manifest);
}

export function serializeWorkspaceScriptManifest(manifest: WorkspaceScriptManifest) {
  return `${JSON.stringify(validateWorkspaceScriptManifest(manifest), null, 2)}\n`;
}
