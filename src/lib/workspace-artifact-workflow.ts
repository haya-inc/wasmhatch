import type { OperatorArtifactAttachment } from "./operator-artifact-browser";
import {
  operatorWorkspaceMediaTypeForPath,
  validateOperatorWorkspacePath
} from "./operator-workspace-bundle";
import {
  WORKSPACE_ARTIFACT_PLAN_LIMITS,
  validateWorkspaceArtifactPlan,
  workspaceArtifactInputMountPath,
  workspaceArtifactOutputMountPath,
  type WorkspaceArtifactPlan
} from "./workspace-artifact-plan";
import {
  WORKSPACE_SCRIPT_DEFAULT_LIMITS,
  validateWorkspaceScriptManifest,
  type WorkspaceScriptManifest,
  type WorkspaceTextMediaType
} from "./workspace-script-contract";
import { workspaceScriptDefinitionPath, type WorkspaceScriptRunSnapshot } from "./workspace-script";

export interface WorkspaceArtifactWorkflowDraft {
  readonly plan: WorkspaceArtifactPlan;
  readonly inputs: readonly OperatorArtifactAttachment[];
}

export interface WorkspaceArtifactScriptDefinition {
  readonly manifest: WorkspaceScriptManifest;
  readonly manifestPath: string;
  readonly source: string;
  readonly outputPath: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function safeIdPart(value: string) {
  const part = value.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (part || "result").slice(0, 96).replace(/-+$/g, "") || "result";
}

function validateInput(input: OperatorArtifactAttachment, index: number) {
  if (!input || typeof input !== "object") throw new Error(`Workspace artifact input ${index + 1} is invalid.`);
  const path = validateOperatorWorkspacePath(input.path);
  const mediaType = operatorWorkspaceMediaTypeForPath(path) as WorkspaceTextMediaType;
  if (input.mediaType !== mediaType) throw new Error(`Workspace artifact input ${index + 1} media type is invalid.`);
  if (!Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > WORKSPACE_SCRIPT_DEFAULT_LIMITS.maxTotalInputBytes) {
    throw new Error(`Workspace artifact input ${index + 1} byte count is invalid.`);
  }
  if (typeof input.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error(`Workspace artifact input ${index + 1} hash is invalid.`);
  }
  return deepFreeze({ ...input, path, mediaType });
}

export function createWorkspaceArtifactWorkflowDraft(
  plan: WorkspaceArtifactPlan,
  inputValues: readonly OperatorArtifactAttachment[]
): WorkspaceArtifactWorkflowDraft {
  const validatedPlan = validateWorkspaceArtifactPlan(plan);
  if (!Array.isArray(inputValues) || inputValues.length < 1 || inputValues.length > 16) {
    throw new Error("Workspace artifact workflow requires 1 to 16 exact inputs.");
  }
  const inputs = inputValues.map(validateInput);
  if (validatedPlan.inputFiles !== inputs.length) throw new Error("Workspace artifact plan input count does not match its exact inputs.");
  if (new Set(inputs.map((input) => input.path)).size !== inputs.length) throw new Error("Workspace artifact workflow inputs contain duplicates.");
  if (inputs.some((input) => input.path === validatedPlan.outputPath)) throw new Error("Workspace artifact output cannot replace a granted input path.");
  const totalBytes = inputs.reduce((total, input) => total + Math.max(1, input.bytes), 0);
  if (totalBytes > WORKSPACE_SCRIPT_DEFAULT_LIMITS.maxTotalInputBytes) {
    throw new Error("Workspace artifact workflow inputs exceed the 512 KB sandbox limit.");
  }
  return deepFreeze({ plan: validatedPlan, inputs: deepFreeze(inputs) });
}

export function createWorkspaceArtifactScriptDefinition(
  draft: WorkspaceArtifactWorkflowDraft,
  sourceValue = draft.plan.script
): WorkspaceArtifactScriptDefinition {
  const validated = createWorkspaceArtifactWorkflowDraft(draft.plan, draft.inputs);
  const source = sourceValue.trim();
  if (!source) throw new Error("Workspace artifact script source is required.");
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_ARTIFACT_PLAN_LIMITS.scriptBytes) {
    throw new Error("Workspace artifact script exceeds 24 KB.");
  }
  const outputName = validated.plan.outputPath.split("/").at(-1)!;
  const id = `artifact-${safeIdPart(outputName)}`;
  const totalInputBytes = validated.inputs.reduce((total, input) => total + Math.max(1, input.bytes), 0);
  const manifest = validateWorkspaceScriptManifest({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    sourcePath: `scripts/${id}.js`,
    inputs: validated.inputs.map((input) => ({
      workspacePath: input.path,
      mountPath: workspaceArtifactInputMountPath(input.path),
      mediaType: input.mediaType,
      maxBytes: Math.max(1, input.bytes)
    })),
    outputs: [{
      workspacePath: validated.plan.outputPath,
      mountPath: workspaceArtifactOutputMountPath(validated.plan.outputMediaType),
      mediaType: validated.plan.outputMediaType,
      maxBytes: WORKSPACE_ARTIFACT_PLAN_LIMITS.outputBytes,
      required: true
    }],
    limits: {
      ...WORKSPACE_SCRIPT_DEFAULT_LIMITS,
      maxTotalInputBytes: totalInputBytes,
      maxTotalOutputBytes: WORKSPACE_ARTIFACT_PLAN_LIMITS.outputBytes
    }
  });
  return deepFreeze({
    manifest,
    manifestPath: workspaceScriptDefinitionPath(manifest),
    source,
    outputPath: validated.plan.outputPath
  });
}

export function assertWorkspaceArtifactRunInputs(
  snapshot: WorkspaceScriptRunSnapshot,
  draft: WorkspaceArtifactWorkflowDraft
) {
  const validated = createWorkspaceArtifactWorkflowDraft(draft.plan, draft.inputs);
  if (snapshot.inputs.length !== validated.inputs.length) throw new Error("Workspace artifact run input count changed after planning.");
  for (const planned of validated.inputs) {
    const observed = snapshot.inputs.find((input) => input.workspacePath === planned.path);
    if (
      !observed ||
      observed.mountPath !== workspaceArtifactInputMountPath(planned.path) ||
      observed.mediaType !== planned.mediaType ||
      observed.bytes !== planned.bytes ||
      observed.sha256 !== planned.sha256
    ) throw new Error(`Workspace artifact input changed after planning: ${planned.path}`);
  }
  return snapshot;
}
