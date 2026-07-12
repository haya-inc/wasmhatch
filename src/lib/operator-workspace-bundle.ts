import { strToU8, unzipSync, zipSync } from "fflate";
import { normalizeWorkspacePath, type WorkspaceFile, type WorkspaceStore } from "./workspace";
import { parseNormalizedArtifactJson } from "./tabular-artifact-persistence";

export const OPERATOR_WORKSPACE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const OPERATOR_WORKSPACE_BUNDLE_KIND = "wasmhatch.operator-workspace" as const;
export const OPERATOR_WORKSPACE_BUNDLE_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  expandedBytes: 8 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  manifestBytes: 128 * 1024,
  files: 128,
  pathBytes: 512
});

export interface OperatorWorkspaceBundleFile {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface OperatorWorkspaceBundleManifest {
  readonly schemaVersion: typeof OPERATOR_WORKSPACE_BUNDLE_SCHEMA_VERSION;
  readonly kind: typeof OPERATOR_WORKSPACE_BUNDLE_KIND;
  readonly exportedAt: string;
  readonly activeArtifactPath: string | null;
  readonly files: readonly OperatorWorkspaceBundleFile[];
  readonly totalBytes: number;
}

export interface OperatorWorkspaceBundle {
  readonly manifest: OperatorWorkspaceBundleManifest;
  readonly files: readonly WorkspaceFile[];
}

export interface OperatorWorkspaceBaseIdentity {
  readonly sha256: string;
  readonly files: readonly OperatorWorkspaceBundleFile[];
}

export interface OperatorWorkspaceRestoreProposal {
  readonly schemaVersion: 1;
  readonly operation: "restore-operator-workspace";
  readonly proposalId: string;
  readonly archiveSha256: string;
  readonly policyDecisionId: string;
  readonly base: OperatorWorkspaceBaseIdentity;
  readonly bundle: OperatorWorkspaceBundleManifest;
}

export interface OperatorWorkspaceClearProposal {
  readonly schemaVersion: 1;
  readonly operation: "clear-operator-workspace";
  readonly proposalId: string;
  readonly policyDecisionId: string;
  readonly base: OperatorWorkspaceBaseIdentity;
}

export type OperatorWorkspaceReplacementOutcome =
  | {
      readonly status: "committed";
      readonly proposalId: string;
      readonly receipt: {
        readonly receiptId: string;
        readonly operation: OperatorWorkspaceRestoreProposal["operation"] | OperatorWorkspaceClearProposal["operation"];
        readonly files: number;
        readonly totalBytes: number;
        readonly activeArtifactPath: string | null;
      };
      readonly bundle: OperatorWorkspaceBundle | null;
    }
  | {
      readonly status: "conflict";
      readonly proposalId: string;
      readonly expectedBaseSha256: string;
      readonly observedBaseSha256: string;
    };

export class OperatorWorkspaceRestoreUncertainError extends Error {
  constructor() {
    super("Operator workspace restore failed and the previous workspace could not be verified after rollback. Export or clear browser storage only after inspecting the current workspace.");
    this.name = "OperatorWorkspaceRestoreUncertainError";
  }
}

const ARCHIVE_ROOT = "wasmhatch-operator-workspace";
const MANIFEST_ENTRY = `${ARCHIVE_ROOT}/manifest.json`;
const FILE_ENTRY_PREFIX = `${ARCHIVE_ROOT}/files/`;
const ALLOWED_ROOTS = new Set(["inputs", "work", "outputs", "scripts", "workflows"]);
const PROTECTED_SEGMENTS = new Set([".aws", ".azure", ".gnupg", ".ssh", "credentials", "secrets"]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const POLICY_DECISION_PATTERN = /^policy_decision_[a-f0-9]{32}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is outside its supported range.`);
  }
  return value as number;
}

function requireIsoDate(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Operator workspace export time is invalid.");
  }
  return value;
}

export function operatorWorkspaceMediaTypeForPath(path: string) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".csv")) return "text/csv";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "text/markdown";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".txt")) return "text/plain";
  throw new Error(`Operator workspace file type is unsupported: ${path}`);
}

export function validateOperatorWorkspacePath(value: unknown) {
  if (typeof value !== "string") throw new Error("Operator workspace path must be a string.");
  const path = normalizeWorkspacePath(value);
  if (path !== value) throw new Error(`Operator workspace path is not canonical: ${value}`);
  if (new TextEncoder().encode(path).byteLength > OPERATOR_WORKSPACE_BUNDLE_LIMITS.pathBytes) {
    throw new Error(`Operator workspace path is too long: ${path}`);
  }
  const segments = path.toLowerCase().split("/");
  if (!ALLOWED_ROOTS.has(segments[0])) throw new Error(`Operator workspace path is outside the portable roots: ${path}`);
  if (
    segments.some((segment) => PROTECTED_SEGMENTS.has(segment)) ||
    segments.some((segment) => segment === ".env" || segment.startsWith(".env.")) ||
    /(?:^|\/)(?:id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i.test(path)
  ) throw new Error(`Operator workspace path targets protected credential material: ${path}`);
  operatorWorkspaceMediaTypeForPath(path);
  return path;
}

function validateTextContent(path: string, content: string) {
  const bytes = byteLength(content);
  if (bytes > OPERATOR_WORKSPACE_BUNDLE_LIMITS.fileBytes) {
    throw new Error(`Operator workspace file exceeds 2 MB: ${path}`);
  }
  if (content.includes("\0")) throw new Error(`Operator workspace file contains a NUL byte: ${path}`);
  return bytes;
}

async function hashBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hashText(content: string) {
  return hashBytes(new TextEncoder().encode(content));
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
  throw new Error("Operator workspace identity contains a non-JSON value.");
}

async function hashIdentity(value: unknown) {
  return hashBytes(new TextEncoder().encode(canonicalJson(value)));
}

async function snapshotStore(store: WorkspaceStore) {
  const paths = await store.listFiles();
  if (paths.length > OPERATOR_WORKSPACE_BUNDLE_LIMITS.files) throw new Error("Operator workspace contains more than 128 files.");
  const canonical = paths.map(validateOperatorWorkspacePath);
  if (new Set(canonical).size !== canonical.length) throw new Error("Operator workspace contains duplicate paths.");
  if (new Set(canonical.map((path) => path.toLowerCase())).size !== canonical.length) {
    throw new Error("Operator workspace contains case-ambiguous paths.");
  }
  const files = await Promise.all(canonical.sort().map(async (path) => {
    const content = await store.readFile(path);
    validateTextContent(path, content);
    return { path, content };
  }));
  const totalBytes = files.reduce((total, file) => total + byteLength(file.content), 0);
  if (totalBytes > OPERATOR_WORKSPACE_BUNDLE_LIMITS.expandedBytes) throw new Error("Operator workspace exceeds the 8 MB portable export limit.");
  return files;
}

async function describeFiles(files: readonly WorkspaceFile[]) {
  return Promise.all(files.map(async (file): Promise<OperatorWorkspaceBundleFile> => {
    const bytes = validateTextContent(file.path, file.content);
    return deepFreeze({
      path: file.path,
      mediaType: operatorWorkspaceMediaTypeForPath(file.path),
      bytes,
      sha256: await hashText(file.content)
    });
  }));
}

async function baseIdentity(files: readonly WorkspaceFile[]): Promise<OperatorWorkspaceBaseIdentity> {
  const descriptors = await describeFiles(files);
  return deepFreeze({ sha256: await hashIdentity(descriptors), files: deepFreeze(descriptors) });
}

function validateArchivePath(name: string) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")) {
    throw new Error("Operator workspace archive contains an unsafe path.");
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Operator workspace archive contains an unsafe path.");
  }
  return parts.join("/");
}

function parseManifest(value: unknown): OperatorWorkspaceBundleManifest {
  assertRecord(value, "Operator workspace manifest");
  assertExactKeys(value, ["schemaVersion", "kind", "exportedAt", "activeArtifactPath", "files", "totalBytes"], "Operator workspace manifest");
  if (value.schemaVersion !== OPERATOR_WORKSPACE_BUNDLE_SCHEMA_VERSION || value.kind !== OPERATOR_WORKSPACE_BUNDLE_KIND) {
    throw new Error("Operator workspace manifest schema is unsupported.");
  }
  if (!Array.isArray(value.files) || value.files.length > OPERATOR_WORKSPACE_BUNDLE_LIMITS.files) {
    throw new Error("Operator workspace manifest contains too many files.");
  }
  const seen = new Set<string>();
  const files = value.files.map((item, index): OperatorWorkspaceBundleFile => {
    assertRecord(item, `Operator workspace manifest file ${index + 1}`);
    assertExactKeys(item, ["path", "mediaType", "bytes", "sha256"], `Operator workspace manifest file ${index + 1}`);
    const path = validateOperatorWorkspacePath(item.path);
    if (seen.has(path)) throw new Error(`Operator workspace manifest contains a duplicate path: ${path}`);
    seen.add(path);
    const mediaType = operatorWorkspaceMediaTypeForPath(path);
    if (item.mediaType !== mediaType) throw new Error(`Operator workspace media type does not match its path: ${path}`);
    const bytes = requireInteger(item.bytes, `Operator workspace file bytes for ${path}`, 0, OPERATOR_WORKSPACE_BUNDLE_LIMITS.fileBytes);
    if (typeof item.sha256 !== "string" || !HASH_PATTERN.test(item.sha256)) throw new Error(`Operator workspace file hash is invalid: ${path}`);
    return deepFreeze({ path, mediaType, bytes, sha256: item.sha256 });
  });
  if (JSON.stringify(files.map((file) => file.path)) !== JSON.stringify(files.map((file) => file.path).sort())) {
    throw new Error("Operator workspace manifest files are not in canonical path order.");
  }
  const totalBytes = requireInteger(value.totalBytes, "Operator workspace total bytes", 0, OPERATOR_WORKSPACE_BUNDLE_LIMITS.expandedBytes);
  if (files.reduce((total, file) => total + file.bytes, 0) !== totalBytes) throw new Error("Operator workspace total bytes do not match its files.");
  let activeArtifactPath: string | null = null;
  if (value.activeArtifactPath !== null) {
    activeArtifactPath = validateOperatorWorkspacePath(value.activeArtifactPath);
    if (!activeArtifactPath.startsWith("inputs/") || !seen.has(activeArtifactPath)) {
      throw new Error("Operator workspace active artifact is not present under inputs/.");
    }
  }
  return deepFreeze({
    schemaVersion: OPERATOR_WORKSPACE_BUNDLE_SCHEMA_VERSION,
    kind: OPERATOR_WORKSPACE_BUNDLE_KIND,
    exportedAt: requireIsoDate(value.exportedAt),
    activeArtifactPath,
    files: deepFreeze(files),
    totalBytes
  });
}

export async function createOperatorWorkspaceBundle(store: WorkspaceStore, options: {
  activeArtifactPath?: string | null;
  exportedAt?: string;
} = {}) {
  const files = await snapshotStore(store);
  const descriptors = await describeFiles(files);
  const activeArtifactPath = options.activeArtifactPath == null ? null : validateOperatorWorkspacePath(options.activeArtifactPath);
  if (activeArtifactPath && (!activeArtifactPath.startsWith("inputs/") || !files.some((file) => file.path === activeArtifactPath))) {
    throw new Error("Active artifact is not present in the operator workspace.");
  }
  if (activeArtifactPath) {
    parseNormalizedArtifactJson(files.find((file) => file.path === activeArtifactPath)!.content);
  }
  const manifest: OperatorWorkspaceBundleManifest = deepFreeze({
    schemaVersion: OPERATOR_WORKSPACE_BUNDLE_SCHEMA_VERSION,
    kind: OPERATOR_WORKSPACE_BUNDLE_KIND,
    exportedAt: requireIsoDate(options.exportedAt ?? new Date().toISOString()),
    activeArtifactPath,
    files: deepFreeze(descriptors),
    totalBytes: descriptors.reduce((total, file) => total + file.bytes, 0)
  });
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
  };
  for (const file of files) entries[`${FILE_ENTRY_PREFIX}${file.path}`] = strToU8(file.content);
  const archive = zipSync(entries, { level: 6 });
  if (archive.byteLength > OPERATOR_WORKSPACE_BUNDLE_LIMITS.archiveBytes) {
    throw new Error("Operator workspace ZIP exceeds the 8 MB archive limit.");
  }
  return { bytes: archive, manifest, fileName: `wasmhatch-operator-workspace-${manifest.exportedAt.slice(0, 10)}.zip` };
}

export async function readOperatorWorkspaceBundle(bytes: Uint8Array): Promise<OperatorWorkspaceBundle> {
  if (!bytes.byteLength || bytes.byteLength > OPERATOR_WORKSPACE_BUNDLE_LIMITS.archiveBytes) {
    throw new Error("Operator workspace ZIP is empty or exceeds 8 MB.");
  }
  let entryCount = 0;
  let expandedBytes = 0;
  const canonicalNames = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        const directory = entry.name.endsWith("/");
        const name = validateArchivePath(directory ? entry.name.slice(0, -1) : entry.name);
        const canonical = name.toLowerCase();
        if (canonicalNames.has(canonical)) throw new Error("Operator workspace ZIP contains duplicate or case-ambiguous paths.");
        canonicalNames.add(canonical);
        if (directory) return false;
        entryCount += 1;
        if (entryCount > OPERATOR_WORKSPACE_BUNDLE_LIMITS.files + 1) throw new Error("Operator workspace ZIP contains too many files.");
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw new Error("Operator workspace ZIP contains an invalid size.");
        const maximum = name === MANIFEST_ENTRY ? OPERATOR_WORKSPACE_BUNDLE_LIMITS.manifestBytes : OPERATOR_WORKSPACE_BUNDLE_LIMITS.fileBytes;
        if (entry.originalSize > maximum) throw new Error("Operator workspace ZIP contains an oversized entry.");
        expandedBytes += entry.originalSize;
        if (expandedBytes > OPERATOR_WORKSPACE_BUNDLE_LIMITS.expandedBytes + OPERATOR_WORKSPACE_BUNDLE_LIMITS.manifestBytes) {
          throw new Error("Operator workspace ZIP expands beyond its limit.");
        }
        if (name !== MANIFEST_ENTRY && !name.startsWith(FILE_ENTRY_PREFIX)) throw new Error("Operator workspace ZIP contains an unexpected entry.");
        return true;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Operator workspace")) throw error;
    throw new Error("Operator workspace ZIP is not a valid archive.");
  }
  const manifestBytes = entries[MANIFEST_ENTRY];
  if (!manifestBytes) throw new Error("Operator workspace ZIP is missing its manifest.");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(UTF8_DECODER.decode(manifestBytes));
  } catch {
    throw new Error("Operator workspace manifest is not valid UTF-8 JSON.");
  }
  const manifest = parseManifest(manifestValue);
  const expectedEntries = new Set([MANIFEST_ENTRY, ...manifest.files.map((file) => `${FILE_ENTRY_PREFIX}${file.path}`)]);
  if (Object.keys(entries).some((name) => !expectedEntries.has(name)) || Object.keys(entries).length !== expectedEntries.size) {
    throw new Error("Operator workspace ZIP entries do not match its manifest.");
  }
  const files = await Promise.all(manifest.files.map(async (descriptor): Promise<WorkspaceFile> => {
    const entry = entries[`${FILE_ENTRY_PREFIX}${descriptor.path}`];
    if (!entry) throw new Error(`Operator workspace ZIP is missing ${descriptor.path}.`);
    if (entry.byteLength !== descriptor.bytes || await hashBytes(entry) !== descriptor.sha256) {
      throw new Error(`Operator workspace file identity does not match its manifest: ${descriptor.path}`);
    }
    let content: string;
    try {
      content = UTF8_DECODER.decode(entry);
    } catch {
      throw new Error(`Operator workspace file is not valid UTF-8: ${descriptor.path}`);
    }
    validateTextContent(descriptor.path, content);
    return Object.freeze({ path: descriptor.path, content });
  }));
  if (manifest.activeArtifactPath) {
    const active = files.find((file) => file.path === manifest.activeArtifactPath);
    if (!active) throw new Error("Operator workspace active artifact is missing after archive validation.");
    parseNormalizedArtifactJson(active.content);
  }
  return deepFreeze({ manifest, files: deepFreeze(files) });
}

async function verifyStore(store: WorkspaceStore, expected: readonly WorkspaceFile[]) {
  const paths = await store.listFiles();
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expected.map((file) => file.path).sort())) {
    throw new Error("Operator workspace paths do not match the restored bundle.");
  }
  for (const file of expected) {
    if (await store.readFile(file.path) !== file.content) throw new Error(`Operator workspace restore verification failed: ${file.path}`);
  }
}

async function restoreOperatorWorkspaceBundle(store: WorkspaceStore, bytes: Uint8Array) {
  const bundle = await readOperatorWorkspaceBundle(bytes);
  const previous = await snapshotStore(store);
  try {
    await store.replaceAll(bundle.files.map((file) => ({ ...file })));
    await verifyStore(store, bundle.files);
  } catch {
    try {
      await store.replaceAll(previous);
      await verifyStore(store, previous);
    } catch {
      throw new OperatorWorkspaceRestoreUncertainError();
    }
    throw new Error("Operator workspace restore failed; the previous workspace was restored and verified.");
  }
  return bundle;
}

function restoreProposalIdentity(proposal: Omit<OperatorWorkspaceRestoreProposal, "proposalId"> | OperatorWorkspaceRestoreProposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    operation: proposal.operation,
    archiveSha256: proposal.archiveSha256,
    policyDecisionId: proposal.policyDecisionId,
    base: proposal.base,
    bundle: proposal.bundle
  };
}

function clearProposalIdentity(proposal: Omit<OperatorWorkspaceClearProposal, "proposalId"> | OperatorWorkspaceClearProposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    operation: proposal.operation,
    policyDecisionId: proposal.policyDecisionId,
    base: proposal.base
  };
}

async function assertBaseIdentity(value: OperatorWorkspaceBaseIdentity) {
  assertRecord(value, "Operator workspace base identity");
  assertExactKeys(value, ["sha256", "files"], "Operator workspace base identity");
  if (typeof value.sha256 !== "string" || !HASH_PATTERN.test(value.sha256)) {
    throw new Error("Operator workspace base identity hash is invalid.");
  }
  if (!Array.isArray(value.files)) throw new Error("Operator workspace base identity files are invalid.");
  const totalBytes = value.files.reduce((total, file) => total + (Number.isInteger(file?.bytes) ? file.bytes : 0), 0);
  const parsed = parseManifest({
    schemaVersion: 1,
    kind: OPERATOR_WORKSPACE_BUNDLE_KIND,
    exportedAt: "1970-01-01T00:00:00.000Z",
    activeArtifactPath: null,
    files: value.files,
    totalBytes
  });
  if (await hashIdentity(parsed.files) !== value.sha256) throw new Error("Operator workspace base identity does not match its files.");
}

async function assertRestoreProposal(proposal: OperatorWorkspaceRestoreProposal) {
  if (
    proposal.schemaVersion !== 1 ||
    proposal.operation !== "restore-operator-workspace" ||
    !/^workspace_restore_[a-f0-9]{64}$/.test(proposal.proposalId) ||
    !HASH_PATTERN.test(proposal.archiveSha256) ||
    !POLICY_DECISION_PATTERN.test(proposal.policyDecisionId) ||
    !HASH_PATTERN.test(proposal.base.sha256)
  ) throw new Error("Operator workspace restore proposal is invalid.");
  await assertBaseIdentity(proposal.base);
  parseManifest(proposal.bundle);
  const expected = `workspace_restore_${(await hashIdentity(restoreProposalIdentity(proposal))).slice("sha256:".length)}`;
  if (proposal.proposalId !== expected) throw new Error("Operator workspace restore proposal identity changed after review.");
}

async function assertClearProposal(proposal: OperatorWorkspaceClearProposal) {
  if (
    proposal.schemaVersion !== 1 ||
    proposal.operation !== "clear-operator-workspace" ||
    !/^workspace_clear_[a-f0-9]{64}$/.test(proposal.proposalId) ||
    !POLICY_DECISION_PATTERN.test(proposal.policyDecisionId) ||
    !HASH_PATTERN.test(proposal.base.sha256)
  ) throw new Error("Operator workspace clear proposal is invalid.");
  await assertBaseIdentity(proposal.base);
  const expected = `workspace_clear_${(await hashIdentity(clearProposalIdentity(proposal))).slice("sha256:".length)}`;
  if (proposal.proposalId !== expected) throw new Error("Operator workspace clear proposal identity changed after review.");
}

export async function prepareOperatorWorkspaceRestore(store: WorkspaceStore, bytes: Uint8Array, policyDecisionId: string) {
  if (!POLICY_DECISION_PATTERN.test(policyDecisionId)) throw new Error("Operator workspace restore policy decision is invalid.");
  const archive = new Uint8Array(bytes.byteLength);
  archive.set(bytes);
  const [bundle, archiveSha256, current] = await Promise.all([
    readOperatorWorkspaceBundle(archive),
    hashBytes(archive),
    snapshotStore(store)
  ]);
  const withoutId = {
    schemaVersion: 1 as const,
    operation: "restore-operator-workspace" as const,
    archiveSha256,
    policyDecisionId,
    base: await baseIdentity(current),
    bundle: bundle.manifest
  };
  return deepFreeze({
    ...withoutId,
    proposalId: `workspace_restore_${(await hashIdentity(withoutId)).slice("sha256:".length)}`
  });
}

export async function executeOperatorWorkspaceRestore(
  store: WorkspaceStore,
  bytes: Uint8Array,
  proposal: OperatorWorkspaceRestoreProposal
): Promise<OperatorWorkspaceReplacementOutcome> {
  await assertRestoreProposal(proposal);
  const archive = new Uint8Array(bytes.byteLength);
  archive.set(bytes);
  if (await hashBytes(archive) !== proposal.archiveSha256) throw new Error("Operator workspace restore archive changed after review.");
  const [bundle, current] = await Promise.all([readOperatorWorkspaceBundle(archive), snapshotStore(store)]);
  if (canonicalJson(bundle.manifest) !== canonicalJson(proposal.bundle)) {
    throw new Error("Operator workspace restore manifest changed after review.");
  }
  const observedBase = await baseIdentity(current);
  if (observedBase.sha256 !== proposal.base.sha256) {
    return deepFreeze({
      status: "conflict" as const,
      proposalId: proposal.proposalId,
      expectedBaseSha256: proposal.base.sha256,
      observedBaseSha256: observedBase.sha256
    });
  }
  const restored = await restoreOperatorWorkspaceBundle(store, archive);
  const receiptSeed = {
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    archiveSha256: proposal.archiveSha256,
    files: restored.manifest.files.length,
    totalBytes: restored.manifest.totalBytes,
    activeArtifactPath: restored.manifest.activeArtifactPath
  };
  return deepFreeze({
    status: "committed" as const,
    proposalId: proposal.proposalId,
    receipt: {
      receiptId: `workspace_receipt_${(await hashIdentity(receiptSeed)).slice("sha256:".length)}`,
      operation: proposal.operation,
      files: restored.manifest.files.length,
      totalBytes: restored.manifest.totalBytes,
      activeArtifactPath: restored.manifest.activeArtifactPath
    },
    bundle: restored
  });
}

export async function prepareOperatorWorkspaceClear(store: WorkspaceStore, policyDecisionId: string) {
  if (!POLICY_DECISION_PATTERN.test(policyDecisionId)) throw new Error("Operator workspace clear policy decision is invalid.");
  const current = await snapshotStore(store);
  const withoutId = {
    schemaVersion: 1 as const,
    operation: "clear-operator-workspace" as const,
    policyDecisionId,
    base: await baseIdentity(current)
  };
  return deepFreeze({
    ...withoutId,
    proposalId: `workspace_clear_${(await hashIdentity(withoutId)).slice("sha256:".length)}`
  });
}

export async function executeOperatorWorkspaceClear(
  store: WorkspaceStore,
  proposal: OperatorWorkspaceClearProposal
): Promise<OperatorWorkspaceReplacementOutcome> {
  await assertClearProposal(proposal);
  const current = await snapshotStore(store);
  const observedBase = await baseIdentity(current);
  if (observedBase.sha256 !== proposal.base.sha256) {
    return deepFreeze({
      status: "conflict" as const,
      proposalId: proposal.proposalId,
      expectedBaseSha256: proposal.base.sha256,
      observedBaseSha256: observedBase.sha256
    });
  }
  try {
    await store.clear();
    if ((await store.listFiles()).length) throw new Error("Operator workspace clear verification failed.");
  } catch {
    try {
      await store.replaceAll(current);
      await verifyStore(store, current);
    } catch {
      throw new OperatorWorkspaceRestoreUncertainError();
    }
    throw new Error("Operator workspace clear failed; the previous workspace was restored and verified.");
  }
  const totalBytes = proposal.base.files.reduce((total, file) => total + file.bytes, 0);
  const receiptSeed = { proposalId: proposal.proposalId, operation: proposal.operation, files: proposal.base.files.length, totalBytes };
  return deepFreeze({
    status: "committed" as const,
    proposalId: proposal.proposalId,
    receipt: {
      receiptId: `workspace_receipt_${(await hashIdentity(receiptSeed)).slice("sha256:".length)}`,
      operation: proposal.operation,
      files: proposal.base.files.length,
      totalBytes,
      activeArtifactPath: null
    },
    bundle: null
  });
}
