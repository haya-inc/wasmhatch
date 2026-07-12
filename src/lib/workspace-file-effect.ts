import { createReadableDiff } from "./diff";
import {
  hashWorkspaceContent,
  type WorkspaceScriptRunSnapshot
} from "./workspace-script";
import type { WorkspaceScriptExecutionResult } from "./workspace-script-runtime";
import type { WorkspaceTextMediaType } from "./workspace-script-contract";
import { normalizeWorkspacePath, type WorkspaceStore } from "./workspace";

export interface WorkspaceFileEffectProposal {
  schemaVersion: 1;
  operation: "write-workspace-file";
  proposalId: string;
  run: {
    runId: string;
    scriptId: string;
    scriptVersion: string;
    manifestPath: string;
    manifestSha256: string;
    sourcePath: string;
    sourceSha256: string;
    inputs: readonly {
      workspacePath: string;
      mountPath: string;
      sha256: string;
      bytes: number;
    }[];
  };
  target: {
    workspacePath: string;
    mountPath: string;
    mediaType: WorkspaceTextMediaType;
  };
  base: {
    existed: boolean;
    content: string | null;
    sha256: string;
  };
  output: {
    content: string;
    sha256: string;
    bytes: number;
  };
  policyDecisionId: string;
}

export interface WorkspaceFileEffectApproval {
  schemaVersion: 1;
  proposalId: string;
  decision: "approve" | "reject";
  reviewerId: string;
}

export type WorkspaceFileEffectOutcome =
  | {
      status: "committed";
      proposalId: string;
      receipt: {
        receiptId: string;
        runId: string;
        workspacePath: string;
        beforeSha256: string;
        afterSha256: string;
        bytes: number;
        preconditionStrength: "recheck";
      };
    }
  | { status: "rejected"; proposalId: string }
  | {
      status: "conflict";
      proposalId: string;
      resourcePath: string;
      expectedSha256: string;
      observedSha256: string;
    }
  | {
      status: "uncertain";
      proposalId: string;
      reason: string;
      reconciliationRequired: true;
    }
  | {
      status: "failed";
      proposalId: string;
      reason: string;
      retryable: boolean;
    };

const PROPOSAL_PREFIX = "file_effect_";
const RECEIPT_PREFIX = "file_receipt_";
const MISSING_HASH = "missing";
const MEDIA_TYPES = new Set<WorkspaceTextMediaType>([
  "application/json", "text/csv", "text/markdown", "text/plain"
]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{64}$/;
const PROPOSAL_ID_PATTERN = /^file_effect_[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function requireText(value: unknown, label: string, maxLength = 512) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters.`);
  return normalized;
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
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function requireHash(value: unknown, label: string, allowMissing = false) {
  if (allowMissing && value === MISSING_HASH) return MISSING_HASH;
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireWorkspacePath(value: unknown, label: string, prefix: string) {
  const raw = requireText(value, label);
  const normalized = normalizeWorkspacePath(raw);
  if (normalized !== raw || !normalized.startsWith(prefix)) throw new Error(`${label} is outside ${prefix}.`);
  return normalized;
}

function requireMountPath(value: unknown, label: string, prefix: "/inputs/" | "/outputs/") {
  const path = requireText(value, label);
  if (!path.startsWith(prefix) || path.includes("\\") || path.includes("//")) {
    throw new Error(`${label} must be a normalized ${prefix} path.`);
  }
  if (path.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} contains an unsafe segment.`);
  }
  return path;
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
  throw new Error("Workspace file effect contains a non-JSON value.");
}

async function hashIdentity(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function proposalIdentity(proposal: Omit<WorkspaceFileEffectProposal, "proposalId"> | WorkspaceFileEffectProposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    operation: proposal.operation,
    run: proposal.run,
    target: proposal.target,
    base: proposal.base,
    output: proposal.output,
    policyDecisionId: proposal.policyDecisionId
  };
}

async function assertValidProposal(proposal: WorkspaceFileEffectProposal) {
  assertRecord(proposal, "Workspace file proposal");
  assertExactKeys(proposal, ["schemaVersion", "operation", "proposalId", "run", "target", "base", "output", "policyDecisionId"], "Workspace file proposal");
  if (proposal.schemaVersion !== 1 || proposal.operation !== "write-workspace-file") {
    throw new Error("Workspace file proposal schema is unsupported.");
  }
  if (typeof proposal.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(proposal.proposalId)) {
    throw new Error("Workspace file proposal ID is invalid.");
  }
  assertRecord(proposal.run, "Workspace script run binding");
  assertExactKeys(proposal.run, ["runId", "scriptId", "scriptVersion", "manifestPath", "manifestSha256", "sourcePath", "sourceSha256", "inputs"], "Workspace script run binding");
  if (!RUN_ID_PATTERN.test(requireText(proposal.run.runId, "Workspace script run ID"))) throw new Error("Workspace script run ID is invalid.");
  const scriptId = requireText(proposal.run.scriptId, "Workspace script ID", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scriptId)) throw new Error("Workspace script ID is invalid.");
  if (!SEMVER_PATTERN.test(requireText(proposal.run.scriptVersion, "Workspace script version", 64))) throw new Error("Workspace script version is invalid.");
  const manifestPath = requireWorkspacePath(proposal.run.manifestPath, "Workspace script manifest path", "workflows/");
  if (manifestPath !== `workflows/${scriptId}.json`) throw new Error("Workspace script manifest path does not match its script ID.");
  requireHash(proposal.run.manifestSha256, "Workspace script manifest hash");
  const sourcePath = requireWorkspacePath(proposal.run.sourcePath, "Workspace script source path", "scripts/");
  if (!sourcePath.endsWith(".js")) throw new Error("Workspace script source path must end in .js.");
  requireHash(proposal.run.sourceSha256, "Workspace script source hash");
  if (!Array.isArray(proposal.run.inputs) || proposal.run.inputs.length < 1 || proposal.run.inputs.length > 32) {
    throw new Error("Workspace file proposal requires 1 to 32 input bindings.");
  }
  const inputPaths = new Set<string>();
  const inputMounts = new Set<string>();
  for (const [index, input] of proposal.run.inputs.entries()) {
    assertRecord(input, `Workspace input binding ${index + 1}`);
    assertExactKeys(input, ["workspacePath", "mountPath", "sha256", "bytes"], `Workspace input binding ${index + 1}`);
    const inputPath = requireText(input.workspacePath, `Workspace input binding ${index + 1} path`);
    const normalizedInputPath = normalizeWorkspacePath(inputPath);
    if (normalizedInputPath !== inputPath || !/^(?:inputs|work|outputs)\//.test(inputPath)) {
      throw new Error(`Workspace input binding ${index + 1} path is outside the readable artifact roots.`);
    }
    const mountPath = requireMountPath(input.mountPath, `Workspace input binding ${index + 1} mount`, "/inputs/");
    if (inputPaths.has(inputPath) || inputMounts.has(mountPath)) throw new Error("Workspace input bindings contain duplicates.");
    inputPaths.add(inputPath);
    inputMounts.add(mountPath);
    requireHash(input.sha256, `Workspace input binding ${index + 1} hash`);
    requireInteger(input.bytes, `Workspace input binding ${index + 1} bytes`, 0, 512 * 1024);
  }

  assertRecord(proposal.target, "Workspace file proposal target");
  assertExactKeys(proposal.target, ["workspacePath", "mountPath", "mediaType"], "Workspace file proposal target");
  requireWorkspacePath(proposal.target.workspacePath, "Workspace file proposal target", "outputs/");
  requireMountPath(proposal.target.mountPath, "Workspace file proposal mount path", "/outputs/");
  if (!MEDIA_TYPES.has(proposal.target.mediaType)) throw new Error("Workspace file proposal media type is unsupported.");
  requireText(proposal.policyDecisionId, "Workspace file policy decision", 256);

  assertRecord(proposal.base, "Workspace file proposal base");
  assertExactKeys(proposal.base, ["existed", "content", "sha256"], "Workspace file proposal base");
  if (typeof proposal.base.existed !== "boolean") throw new Error("Workspace file proposal base existence is invalid.");
  if (proposal.base.content !== null && typeof proposal.base.content !== "string") throw new Error("Workspace file proposal base content is invalid.");
  if (proposal.base.existed !== (proposal.base.content !== null)) throw new Error("Workspace file proposal base state is inconsistent.");
  requireHash(proposal.base.sha256, "Workspace file proposal base hash", true);
  const expectedBaseHash = proposal.base.content === null ? MISSING_HASH : await hashWorkspaceContent(proposal.base.content);
  if (proposal.base.sha256 !== expectedBaseHash) throw new Error("Workspace file proposal base hash is invalid.");

  assertRecord(proposal.output, "Workspace file proposal output");
  assertExactKeys(proposal.output, ["content", "sha256", "bytes"], "Workspace file proposal output");
  if (typeof proposal.output.content !== "string") throw new Error("Workspace file proposal output content is invalid.");
  requireHash(proposal.output.sha256, "Workspace file proposal output hash");
  requireInteger(proposal.output.bytes, "Workspace file proposal output bytes", 0, 512 * 1024);
  const outputHash = await hashWorkspaceContent(proposal.output.content);
  if (proposal.output.sha256 !== outputHash || proposal.output.bytes !== byteLength(proposal.output.content)) {
    throw new Error("Workspace file proposal output identity is invalid.");
  }
  const expectedId = `${PROPOSAL_PREFIX}${await hashIdentity(proposalIdentity(proposal))}`;
  if (proposal.proposalId !== expectedId) throw new Error("Workspace file proposal identity is invalid or was edited.");
}

export async function prepareWorkspaceFileEffects(
  snapshot: WorkspaceScriptRunSnapshot,
  execution: WorkspaceScriptExecutionResult,
  policyDecisionId: string
) {
  if (execution.runId !== snapshot.runId) throw new Error("Workspace script result does not match its prepared run.");
  const policy = requireText(policyDecisionId, "Workspace file policy decision", 256);
  const bases = new Map(snapshot.outputBases.map((base) => [base.mountPath, base]));
  const proposals = await Promise.all(execution.outputs.map(async (output): Promise<WorkspaceFileEffectProposal | null> => {
    const base = bases.get(output.mountPath);
    if (!base || base.workspacePath !== output.workspacePath || base.mediaType !== output.mediaType) {
      throw new Error("Workspace script output does not match its manifest grant.");
    }
    if (base.before === output.content) return null;
    const withoutId = {
      schemaVersion: 1 as const,
      operation: "write-workspace-file" as const,
      run: {
        runId: snapshot.runId,
        scriptId: snapshot.manifest.id,
        scriptVersion: snapshot.manifest.version,
        manifestPath: snapshot.manifestPath,
        manifestSha256: snapshot.manifestSha256,
        sourcePath: snapshot.manifest.sourcePath,
        sourceSha256: snapshot.sourceSha256,
        inputs: snapshot.inputs.map(({ workspacePath, mountPath, sha256, bytes }) => ({
          workspacePath, mountPath, sha256, bytes
        }))
      },
      target: {
        workspacePath: output.workspacePath,
        mountPath: output.mountPath,
        mediaType: output.mediaType
      },
      base: {
        existed: base.before !== null,
        content: base.before,
        sha256: base.baseSha256
      },
      output: {
        content: output.content,
        sha256: await hashWorkspaceContent(output.content),
        bytes: output.bytes
      },
      policyDecisionId: policy
    };
    return deepFreeze({
      ...withoutId,
      proposalId: `${PROPOSAL_PREFIX}${await hashIdentity(withoutId)}`
    });
  }));
  return deepFreeze(proposals.filter((proposal): proposal is WorkspaceFileEffectProposal => proposal !== null));
}

export function decideWorkspaceFileEffect(
  proposal: WorkspaceFileEffectProposal,
  decision: "approve" | "reject",
  reviewerId: string
): WorkspaceFileEffectApproval {
  return deepFreeze({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    decision,
    reviewerId: requireText(reviewerId, "Workspace file reviewer", 256)
  });
}

async function observe(store: WorkspaceStore, path: string) {
  const paths = new Set(await store.listFiles());
  if (!paths.has(path)) return { content: null, sha256: MISSING_HASH };
  const content = await store.readFile(path);
  return { content, sha256: await hashWorkspaceContent(content) };
}

export async function executeWorkspaceFileEffect(
  proposal: WorkspaceFileEffectProposal,
  approval: WorkspaceFileEffectApproval,
  store: WorkspaceStore
): Promise<WorkspaceFileEffectOutcome> {
  try {
    await assertValidProposal(proposal);
    assertRecord(approval, "Workspace file approval");
    assertExactKeys(approval, ["schemaVersion", "proposalId", "decision", "reviewerId"], "Workspace file approval");
    if (
      approval.schemaVersion !== 1 ||
      approval.proposalId !== proposal.proposalId ||
      (approval.decision !== "approve" && approval.decision !== "reject") ||
      !requireText(approval.reviewerId, "Workspace file reviewer", 256)
    ) {
      throw new Error("Workspace file approval does not match the exact proposal.");
    }
  } catch (error) {
    return {
      status: "failed",
      proposalId: proposal.proposalId,
      reason: error instanceof Error ? error.message : "Workspace file proposal validation failed.",
      retryable: false
    };
  }
  if (approval.decision === "reject") return { status: "rejected", proposalId: proposal.proposalId };

  const dependencies = [
    { path: proposal.run.manifestPath, sha256: proposal.run.manifestSha256 },
    { path: proposal.run.sourcePath, sha256: proposal.run.sourceSha256 },
    ...proposal.run.inputs.map((input) => ({ path: input.workspacePath, sha256: input.sha256 }))
  ];
  for (const dependency of dependencies) {
    let currentDependency: Awaited<ReturnType<typeof observe>>;
    try {
      currentDependency = await observe(store, dependency.path);
    } catch {
      return {
        status: "failed",
        proposalId: proposal.proposalId,
        reason: `The workspace dependency could not be re-read: ${dependency.path}`,
        retryable: true
      };
    }
    if (currentDependency.sha256 !== dependency.sha256) {
      return {
        status: "conflict",
        proposalId: proposal.proposalId,
        resourcePath: dependency.path,
        expectedSha256: dependency.sha256,
        observedSha256: currentDependency.sha256
      };
    }
  }

  let current: Awaited<ReturnType<typeof observe>>;
  try {
    current = await observe(store, proposal.target.workspacePath);
  } catch {
    return {
      status: "failed",
      proposalId: proposal.proposalId,
      reason: "The current workspace file could not be re-read before commit.",
      retryable: true
    };
  }
  if (current.sha256 !== proposal.base.sha256) {
    return {
      status: "conflict",
      proposalId: proposal.proposalId,
      resourcePath: proposal.target.workspacePath,
      expectedSha256: proposal.base.sha256,
      observedSha256: current.sha256
    };
  }

  const receiptSeed = {
    proposalId: proposal.proposalId,
    runId: proposal.run.runId,
    workspacePath: proposal.target.workspacePath,
    beforeSha256: proposal.base.sha256,
    afterSha256: proposal.output.sha256,
    bytes: proposal.output.bytes,
    preconditionStrength: "recheck" as const
  };
  let receiptId: string;
  try {
    receiptId = `${RECEIPT_PREFIX}${await hashIdentity(receiptSeed)}`;
  } catch {
    return {
      status: "failed",
      proposalId: proposal.proposalId,
      reason: "The workspace receipt identity could not be prepared before writing.",
      retryable: true
    };
  }

  let writeError = false;
  try {
    await store.writeFile(proposal.target.workspacePath, proposal.output.content);
  } catch {
    writeError = true;
  }
  let observed: Awaited<ReturnType<typeof observe>>;
  try {
    observed = await observe(store, proposal.target.workspacePath);
  } catch {
    return {
      status: "uncertain",
      proposalId: proposal.proposalId,
      reason: "The workspace write could not be verified. Reconcile the output before retrying.",
      reconciliationRequired: true
    };
  }
  if (observed.sha256 === proposal.output.sha256) {
    return {
      status: "committed",
      proposalId: proposal.proposalId,
      receipt: deepFreeze({ receiptId, ...receiptSeed })
    };
  }
  if (writeError && observed.sha256 === proposal.base.sha256) {
    return {
      status: "failed",
      proposalId: proposal.proposalId,
      reason: "The workspace write was rejected before changing the file.",
      retryable: true
    };
  }
  return {
    status: "uncertain",
    proposalId: proposal.proposalId,
    reason: "The workspace output does not match either the reviewed base or approved content. Reconcile before retrying.",
    reconciliationRequired: true
  };
}

export function workspaceFileEffectDiff(proposal: WorkspaceFileEffectProposal) {
  return createReadableDiff(
    proposal.target.workspacePath,
    proposal.base.content ?? "",
    proposal.output.content
  );
}
