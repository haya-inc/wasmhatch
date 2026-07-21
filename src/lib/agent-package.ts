import { strToU8, unzipSync, zipSync } from "fflate";
import { isProtectedAgentPath } from "./secrets";
import { normalizeWorkspacePath, type WorkspaceFile } from "./workspace";

export const PORTABLE_AGENT_SCHEMA_VERSION = 1 as const;
export const PORTABLE_AGENT_KIND = "wasmhatch.agent" as const;
export const PORTABLE_AGENT_CORE_VERSION = "0.46.0";
export const PORTABLE_AGENT_MEDIA_TYPE = "application/vnd.wasmhatch.agent+zip";
export const PORTABLE_AGENT_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  expandedBytes: 8 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  manifestBytes: 128 * 1024,
  files: 128,
  pathBytes: 512,
  examples: 8,
  tools: 64,
  networkOrigins: 32
});

export interface PortableAgentCompatibility {
  readonly minInclusive: string;
  readonly maxExclusive: string;
}

export interface PortableAgentPermissions {
  readonly tools: readonly string[];
  readonly networkOrigins: readonly string[];
}

export interface PortableAgentExample {
  readonly title: string;
  readonly prompt: string;
}

export interface PortableAgentFileDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PortableAgentManifest {
  readonly schemaVersion: typeof PORTABLE_AGENT_SCHEMA_VERSION;
  readonly kind: typeof PORTABLE_AGENT_KIND;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly version: string;
  readonly license: string;
  readonly compatibleCore: PortableAgentCompatibility;
  readonly entrypoint: string;
  readonly permissions: PortableAgentPermissions;
  readonly examples: readonly PortableAgentExample[];
  readonly files: readonly PortableAgentFileDescriptor[];
  readonly totalBytes: number;
}

export interface PortableAgentDraft {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly version: string;
  readonly license: string;
  readonly compatibleCore?: PortableAgentCompatibility;
  readonly entrypoint: string;
  readonly permissions?: Partial<PortableAgentPermissions>;
  readonly examples?: readonly PortableAgentExample[];
}

export interface PortableAgentPackage {
  readonly manifest: PortableAgentManifest;
  readonly files: readonly WorkspaceFile[];
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

const ARCHIVE_ROOT = "wasmhatch-agent";
const MANIFEST_ENTRY = `${ARCHIVE_ROOT}/manifest.json`;
const FILE_ENTRY_PREFIX = `${ARCHIVE_ROOT}/files/`;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function containsControlCharacters(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximum) throw new Error(`${label} is too long.`);
  if (containsControlCharacters(normalized)) throw new Error(`${label} contains control characters.`);
  return normalized;
}

function requirePrompt(value: unknown) {
  if (typeof value !== "string") throw new Error("Agent example prompt must be a string.");
  const normalized = value.trim();
  if (!normalized) throw new Error("Agent example prompt is required.");
  if (normalized.length > 4000) throw new Error("Agent example prompt is too long.");
  if (normalized.includes("\0")) throw new Error("Agent example prompt contains a NUL byte.");
  return normalized;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function parseVersion(value: unknown, label: string) {
  const version = requireText(value, label, 64);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`${label} must be a stable semantic version.`);
  return { value: version, parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const };
}

function compareVersions(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateCompatibility(value: unknown): PortableAgentCompatibility {
  assertExactKeys(value, ["minInclusive", "maxExclusive"], "Agent core compatibility");
  const minimum = parseVersion(value.minInclusive, "Minimum compatible core version");
  const maximum = parseVersion(value.maxExclusive, "Maximum compatible core version");
  if (compareVersions(minimum.parts, maximum.parts) >= 0) {
    throw new Error("Agent core compatibility range must not be empty.");
  }
  return Object.freeze({ minInclusive: minimum.value, maxExclusive: maximum.value });
}

function validateAgentPath(value: unknown) {
  const input = requireText(value, "Agent file path", PORTABLE_AGENT_LIMITS.pathBytes);
  const path = normalizeWorkspacePath(input);
  if (path !== input) throw new Error(`Agent file path is not canonical: ${input}`);
  if (new TextEncoder().encode(path).byteLength > PORTABLE_AGENT_LIMITS.pathBytes) {
    throw new Error(`Agent file path is too long: ${path}`);
  }
  if (isProtectedAgentPath(path)) throw new Error(`Agent package cannot contain protected credential material: ${path}`);
  return path;
}

function normalizeOrigin(value: unknown) {
  const input = requireText(value, "Agent network origin", 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Agent network origin must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Agent network origins must be HTTPS origins without credentials, paths, queries, or fragments.");
  }
  return url.origin;
}

function validateStringArray(
  value: unknown,
  label: string,
  maximum: number,
  validate: (entry: unknown) => string
) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} entries.`);
  const entries = value.map(validate);
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicates.`);
  return Object.freeze(entries);
}

function validatePermissions(value: unknown): PortableAgentPermissions {
  assertExactKeys(value, ["tools", "networkOrigins"], "Agent permissions");
  const tools = validateStringArray(value.tools, "Agent tools", PORTABLE_AGENT_LIMITS.tools, (entry) => {
    const tool = requireText(entry, "Agent tool", 128);
    if (!TOOL_PATTERN.test(tool)) throw new Error("Agent tool IDs must use lower-case identifier syntax.");
    return tool;
  });
  const networkOrigins = validateStringArray(
    value.networkOrigins,
    "Agent network origins",
    PORTABLE_AGENT_LIMITS.networkOrigins,
    normalizeOrigin
  );
  return Object.freeze({ tools, networkOrigins });
}

function validateExamples(value: unknown) {
  if (!Array.isArray(value) || value.length > PORTABLE_AGENT_LIMITS.examples) {
    throw new Error(`Agent examples must contain at most ${PORTABLE_AGENT_LIMITS.examples} entries.`);
  }
  return Object.freeze(value.map((example): PortableAgentExample => {
    assertExactKeys(example, ["title", "prompt"], "Agent example");
    return Object.freeze({
      title: requireText(example.title, "Agent example title", 120),
      prompt: requirePrompt(example.prompt)
    });
  }));
}

function validateFileDescriptors(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > PORTABLE_AGENT_LIMITS.files) {
    throw new Error(`Agent files must contain from 1 to ${PORTABLE_AGENT_LIMITS.files} entries.`);
  }
  const descriptors = value.map((file): PortableAgentFileDescriptor => {
    assertExactKeys(file, ["path", "mediaType", "bytes", "sha256"], "Agent file descriptor");
    const path = validateAgentPath(file.path);
    const mediaType = requireText(file.mediaType, "Agent file media type", 128).toLowerCase();
    if (!MEDIA_TYPE_PATTERN.test(mediaType)) throw new Error(`Agent file media type is invalid: ${path}`);
    const bytes = requireInteger(file.bytes, `Agent file byte count for ${path}`, 0, PORTABLE_AGENT_LIMITS.fileBytes);
    const sha256 = requireText(file.sha256, `Agent file hash for ${path}`, 71).toLowerCase();
    if (!HASH_PATTERN.test(sha256)) throw new Error(`Agent file hash is invalid: ${path}`);
    return Object.freeze({ path, mediaType, bytes, sha256 });
  });
  const paths = descriptors.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error("Agent manifest contains duplicate file paths.");
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new Error("Agent manifest contains case-ambiguous file paths.");
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error("Agent manifest files must be sorted by path.");
  }
  return Object.freeze(descriptors);
}

export function validatePortableAgentManifest(value: unknown): PortableAgentManifest {
  assertExactKeys(value, [
    "schemaVersion", "kind", "id", "name", "summary", "version", "license",
    "compatibleCore", "entrypoint", "permissions", "examples", "files", "totalBytes"
  ], "Agent manifest");
  if (value.schemaVersion !== PORTABLE_AGENT_SCHEMA_VERSION || value.kind !== PORTABLE_AGENT_KIND) {
    throw new Error("Agent package schema is unsupported.");
  }
  const id = requireText(value.id, "Agent ID", 64);
  if (!ID_PATTERN.test(id)) throw new Error("Agent ID must use lower-case kebab syntax.");
  const version = parseVersion(value.version, "Agent version").value;
  const compatibleCore = validateCompatibility(value.compatibleCore);
  const entrypoint = validateAgentPath(value.entrypoint);
  const permissions = validatePermissions(value.permissions);
  const examples = validateExamples(value.examples);
  const files = validateFileDescriptors(value.files);
  if (!files.some((file) => file.path === entrypoint)) throw new Error("Agent entrypoint is not present in the package files.");
  const totalBytes = requireInteger(value.totalBytes, "Agent total byte count", 0, PORTABLE_AGENT_LIMITS.expandedBytes);
  if (files.reduce((total, file) => total + file.bytes, 0) !== totalBytes) {
    throw new Error("Agent total byte count does not match its files.");
  }
  return Object.freeze({
    schemaVersion: PORTABLE_AGENT_SCHEMA_VERSION,
    kind: PORTABLE_AGENT_KIND,
    id,
    name: requireText(value.name, "Agent name", 120),
    summary: requireText(value.summary, "Agent summary", 500),
    version,
    license: requireText(value.license, "Agent license", 128),
    compatibleCore,
    entrypoint,
    permissions,
    examples,
    files,
    totalBytes
  });
}

function mediaTypeForPath(path: string) {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  if (extension === "json") return "application/json";
  if (extension === "js" || extension === "mjs") return "text/javascript";
  if (extension === "ts" || extension === "mts") return "text/typescript";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "css") return "text/css";
  if (extension === "csv") return "text/csv";
  if (extension === "yaml" || extension === "yml") return "application/yaml";
  if (extension === "toml") return "application/toml";
  return "text/plain";
}

async function hashBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function decodeText(bytes: Uint8Array, label: string) {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 text.`);
  }
  if (text.includes("\0")) throw new Error(`${label} contains a NUL byte.`);
  return text;
}

function validateDraft(draft: PortableAgentDraft, files: readonly WorkspaceFile[]) {
  const normalizedFiles = files.map((file) => Object.freeze({ path: validateAgentPath(file.path), content: file.content }));
  if (normalizedFiles.length < 1 || normalizedFiles.length > PORTABLE_AGENT_LIMITS.files) {
    throw new Error(`Agent packages must contain from 1 to ${PORTABLE_AGENT_LIMITS.files} files.`);
  }
  const paths = normalizedFiles.map((file) => file.path);
  if (new Set(paths).size !== paths.length || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new Error("Agent package contains duplicate or case-ambiguous paths.");
  }
  return {
    normalizedFiles: normalizedFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    draft
  };
}

export async function createPortableAgentPackage(
  draft: PortableAgentDraft,
  files: readonly WorkspaceFile[]
): Promise<PortableAgentPackage> {
  const validated = validateDraft(draft, files);
  const descriptors: PortableAgentFileDescriptor[] = [];
  let totalBytes = 0;
  for (const file of validated.normalizedFiles) {
    const bytes = strToU8(file.content);
    if (bytes.byteLength > PORTABLE_AGENT_LIMITS.fileBytes) throw new Error(`Agent file exceeds 2 MB: ${file.path}`);
    if (file.content.includes("\0")) throw new Error(`Agent file contains a NUL byte: ${file.path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > PORTABLE_AGENT_LIMITS.expandedBytes) throw new Error("Agent files exceed the 8 MB package limit.");
    descriptors.push(Object.freeze({
      path: file.path,
      mediaType: mediaTypeForPath(file.path),
      bytes: bytes.byteLength,
      sha256: await hashBytes(bytes)
    }));
  }

  const manifest = validatePortableAgentManifest({
    schemaVersion: PORTABLE_AGENT_SCHEMA_VERSION,
    kind: PORTABLE_AGENT_KIND,
    id: draft.id,
    name: draft.name,
    summary: draft.summary,
    version: draft.version,
    license: draft.license,
    compatibleCore: draft.compatibleCore ?? { minInclusive: PORTABLE_AGENT_CORE_VERSION, maxExclusive: "1.0.0" },
    entrypoint: draft.entrypoint,
    permissions: {
      tools: draft.permissions?.tools ?? [],
      networkOrigins: draft.permissions?.networkOrigins ?? []
    },
    examples: draft.examples ?? [],
    files: descriptors,
    totalBytes
  });
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBytes.byteLength > PORTABLE_AGENT_LIMITS.manifestBytes) throw new Error("Agent manifest exceeds 128 KB.");
  const archiveEntries: Record<string, Uint8Array> = { [MANIFEST_ENTRY]: manifestBytes };
  for (const file of validated.normalizedFiles) archiveEntries[`${FILE_ENTRY_PREFIX}${file.path}`] = strToU8(file.content);
  const bytes = zipSync(archiveEntries, { level: 6 });
  if (bytes.byteLength > PORTABLE_AGENT_LIMITS.archiveBytes) throw new Error("Agent archive exceeds 8 MB.");
  return Object.freeze({ manifest, files: Object.freeze(validated.normalizedFiles), sha256: await hashBytes(bytes), bytes });
}

function validateArchiveEntry(name: string) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")) {
    throw new Error("Agent archive contains an unsafe path.");
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Agent archive contains an unsafe path.");
  }
  if (name === MANIFEST_ENTRY) return name;
  if (!name.startsWith(FILE_ENTRY_PREFIX)) throw new Error(`Agent archive contains an unsupported entry: ${name}`);
  validateAgentPath(name.slice(FILE_ENTRY_PREFIX.length));
  return name;
}

export async function readPortableAgentPackage(input: Uint8Array): Promise<PortableAgentPackage> {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength > PORTABLE_AGENT_LIMITS.archiveBytes) throw new Error("Agent archive exceeds 8 MB.");
  let expandedBytes = 0;
  let fileEntries = 0;
  const seen = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name.endsWith("/")) return false;
        const name = validateArchiveEntry(entry.name);
        if (seen.has(name)) throw new Error(`Agent archive contains a duplicate entry: ${name}`);
        seen.add(name);
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new Error("Agent archive contains an invalid file size.");
        }
        const maximum = name === MANIFEST_ENTRY ? PORTABLE_AGENT_LIMITS.manifestBytes : PORTABLE_AGENT_LIMITS.fileBytes;
        if (entry.originalSize > maximum) throw new Error(`Agent archive entry is too large: ${name}`);
        expandedBytes += entry.originalSize;
        if (expandedBytes > PORTABLE_AGENT_LIMITS.expandedBytes + PORTABLE_AGENT_LIMITS.manifestBytes) {
          throw new Error("Agent archive expands beyond its supported limit.");
        }
        if (name !== MANIFEST_ENTRY) {
          fileEntries += 1;
          if (fileEntries > PORTABLE_AGENT_LIMITS.files) throw new Error("Agent archive contains too many files.");
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent archive")) throw error;
    throw new Error("Agent package is not a valid ZIP archive.");
  }

  const manifestBytes = entries[MANIFEST_ENTRY];
  if (!manifestBytes) throw new Error("Agent archive is missing its manifest.");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(decodeText(manifestBytes, "Agent manifest"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent manifest")) throw error;
    throw new Error("Agent manifest is not valid JSON.");
  }
  const manifest = validatePortableAgentManifest(manifestValue);
  const files: WorkspaceFile[] = [];
  for (const descriptor of manifest.files) {
    const archivePath = `${FILE_ENTRY_PREFIX}${descriptor.path}`;
    const contentBytes = entries[archivePath];
    if (!contentBytes) throw new Error(`Agent archive is missing a declared file: ${descriptor.path}`);
    if (contentBytes.byteLength !== descriptor.bytes) throw new Error(`Agent file byte count does not match: ${descriptor.path}`);
    if (await hashBytes(contentBytes) !== descriptor.sha256) throw new Error(`Agent file hash does not match: ${descriptor.path}`);
    files.push({ path: descriptor.path, content: decodeText(contentBytes, `Agent file ${descriptor.path}`) });
  }
  const expectedEntries = new Set([MANIFEST_ENTRY, ...manifest.files.map((file) => `${FILE_ENTRY_PREFIX}${file.path}`)]);
  const extra = Object.keys(entries).find((entry) => !expectedEntries.has(entry));
  if (extra) throw new Error(`Agent archive contains an undeclared file: ${extra}`);
  return Object.freeze({ manifest, files: Object.freeze(files), sha256: await hashBytes(bytes), bytes });
}

function validatePackageUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Agent package URL is invalid.");
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) {
    throw new Error("Agent packages must use HTTPS URLs without embedded credentials.");
  }
  return url;
}

export async function fetchPortableAgentPackage(
  input: string,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {}
) {
  const url = validatePackageUrl(input);
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: PORTABLE_AGENT_MEDIA_TYPE },
    signal: options.signal
  });
  if (!response.ok) throw new Error(`Agent package download failed (${response.status}).`);
  validatePackageUrl(response.url || url.href);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PORTABLE_AGENT_LIMITS.archiveBytes) {
    throw new Error("Agent archive exceeds 8 MB.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return readPortableAgentPackage(bytes);
}
