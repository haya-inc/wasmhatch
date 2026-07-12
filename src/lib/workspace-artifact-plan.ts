import {
  operatorWorkspaceMediaTypeForPath,
  validateOperatorWorkspacePath
} from "./operator-workspace-bundle";
import type { WorkspaceTextMediaType } from "./workspace-script-contract";

export const WORKSPACE_ARTIFACT_PLAN_LIMITS = Object.freeze({
  scriptBytes: 24 * 1024,
  outputBytes: 256 * 1024,
  listItems: 8
});

export interface WorkspaceArtifactPlan {
  readonly kind: "artifact-output";
  readonly summary: string;
  readonly expectedEffect: string;
  readonly outputPath: string;
  readonly outputMediaType: WorkspaceTextMediaType;
  readonly script: string;
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
  readonly model: string;
  readonly responseId: string;
  readonly inputFiles: number;
}

export const WORKSPACE_ARTIFACT_PLAN_TOOL = {
  type: "function",
  name: "propose_workspace_artifact",
  description: "Propose one synchronous, deterministic workspace script that reads only the declared virtual input mounts and writes one bounded text artifact. This stages source and output metadata for foreground review; it does not execute or write anything.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Concise business-language description of the artifact workflow." },
      expected_effect: { type: "string", description: "What output will be created or replaced and what inputs remain unchanged." },
      output_path: { type: "string", description: "Canonical workspace path under outputs/ ending in .md, .markdown, .csv, .json, .txt, or .js." },
      media_type: {
        type: "string",
        enum: ["text/markdown", "text/csv", "application/json", "text/plain", "text/javascript"],
        description: "Media type matching the output filename extension. JavaScript output is inert text and is not automatically executed."
      },
      script: {
        type: "string",
        description: "A synchronous JavaScript function expression receiving ({ fs, args }). Read only declared /inputs/workspace/... mounts and call fs.writeText exactly once for the declared /outputs/result.* mount. No imports, async, network, DOM, credentials, model calls, or undeclared paths."
      },
      assumptions: { type: "array", items: { type: "string" }, description: "Assumptions a reviewer must verify." },
      warnings: { type: "array", items: { type: "string" }, description: "Material interpretation or data-quality risks." }
    },
    required: ["summary", "expected_effect", "output_path", "media_type", "script", "assumptions", "warnings"],
    additionalProperties: false
  },
  strict: true
} as const;

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

function requireText(value: unknown, label: string, maximum: number, multiline = false) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length > maximum || byteLength(text) > maximum) throw new Error(`${label} is too long.`);
  if (text.includes("\0") || (!multiline && /[\u0000-\u001f\u007f]/.test(text))) throw new Error(`${label} contains control characters.`);
  return text;
}

function requireList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > WORKSPACE_ARTIFACT_PLAN_LIMITS.listItems) {
    throw new Error(`${label} must contain at most ${WORKSPACE_ARTIFACT_PLAN_LIMITS.listItems} items.`);
  }
  return value.map((item, index) => requireText(item, `${label} item ${index + 1}`, 500));
}

export function workspaceArtifactOutputMountPath(mediaType: WorkspaceTextMediaType) {
  const extension: Record<WorkspaceTextMediaType, string> = {
    "application/json": ".json",
    "text/csv": ".csv",
    "text/javascript": ".js",
    "text/markdown": ".md",
    "text/plain": ".txt"
  };
  return `/outputs/result${extension[mediaType]}`;
}

export function workspaceArtifactInputMountPath(workspacePath: string) {
  return `/inputs/workspace/${validateOperatorWorkspacePath(workspacePath)}`;
}

export function parseWorkspaceArtifactPlanArguments(
  value: unknown,
  metadata: { model: string; responseId: string; inputFiles: number }
): WorkspaceArtifactPlan {
  assertRecord(value, "Workspace artifact plan");
  assertExactKeys(value, ["summary", "expected_effect", "output_path", "media_type", "script", "assumptions", "warnings"], "Workspace artifact plan");
  const outputPath = validateOperatorWorkspacePath(value.output_path);
  if (!outputPath.startsWith("outputs/")) throw new Error("Workspace artifact output must be under outputs/.");
  const expectedMediaType = operatorWorkspaceMediaTypeForPath(outputPath) as WorkspaceTextMediaType;
  if (value.media_type !== expectedMediaType || !(["application/json", "text/csv", "text/javascript", "text/markdown", "text/plain"] as const).includes(expectedMediaType)) {
    throw new Error("Workspace artifact output media type does not match its filename.");
  }
  if (!Number.isInteger(metadata.inputFiles) || metadata.inputFiles < 1 || metadata.inputFiles > 16) {
    throw new Error("Workspace artifact plan input count is invalid.");
  }
  return deepFreeze({
    kind: "artifact-output",
    summary: requireText(value.summary, "Workspace artifact plan summary", 1_000),
    expectedEffect: requireText(value.expected_effect, "Workspace artifact expected effect", 1_000),
    outputPath,
    outputMediaType: expectedMediaType,
    script: requireText(value.script, "Workspace artifact script", WORKSPACE_ARTIFACT_PLAN_LIMITS.scriptBytes, true),
    assumptions: deepFreeze(requireList(value.assumptions, "Workspace artifact assumptions")),
    warnings: deepFreeze(requireList(value.warnings, "Workspace artifact warnings")),
    model: requireText(metadata.model, "Workspace artifact model", 128),
    responseId: requireText(metadata.responseId, "Workspace artifact response ID", 256),
    inputFiles: metadata.inputFiles
  });
}

export function validateWorkspaceArtifactPlan(value: WorkspaceArtifactPlan): WorkspaceArtifactPlan {
  assertRecord(value, "Workspace artifact plan");
  assertExactKeys(value, [
    "kind", "summary", "expectedEffect", "outputPath", "outputMediaType", "script",
    "assumptions", "warnings", "model", "responseId", "inputFiles"
  ], "Workspace artifact plan");
  if (value.kind !== "artifact-output") throw new Error("Workspace artifact plan kind is invalid.");
  return parseWorkspaceArtifactPlanArguments({
    summary: value.summary,
    expected_effect: value.expectedEffect,
    output_path: value.outputPath,
    media_type: value.outputMediaType,
    script: value.script,
    assumptions: value.assumptions,
    warnings: value.warnings
  }, { model: value.model, responseId: value.responseId, inputFiles: value.inputFiles });
}

export async function validateWorkspaceArtifactOutputContent(mediaType: WorkspaceTextMediaType, content: string) {
  if (typeof content !== "string" || !content.length) throw new Error("Workspace artifact output is empty.");
  if (content.includes("\0")) throw new Error("Workspace artifact output contains a NUL byte.");
  if (byteLength(content) > WORKSPACE_ARTIFACT_PLAN_LIMITS.outputBytes) throw new Error("Workspace artifact output exceeds 256 KB.");
  if (mediaType === "application/json") {
    try { JSON.parse(content); } catch { throw new Error("Workspace artifact JSON output is invalid."); }
  }
  if (mediaType === "text/csv") {
    const { validateCsvTextArtifact } = await import("./tabular-artifact");
    const validated = validateCsvTextArtifact(content);
    if (validated.formulaCells) throw new Error("Workspace artifact CSV output contains formula-looking cells. Prefix intended literals with an apostrophe before staging the file.");
  }
  return content;
}
