import { describe, expect, it } from "vitest";
import type { OperatorArtifactAttachment } from "./operator-artifact-browser";
import {
  parseWorkspaceArtifactPlanArguments,
  validateWorkspaceArtifactOutputContent,
  workspaceArtifactInputMountPath,
  workspaceArtifactOutputMountPath
} from "./workspace-artifact-plan";
import {
  assertWorkspaceArtifactRunInputs,
  createWorkspaceArtifactScriptDefinition,
  createWorkspaceArtifactWorkflowDraft
} from "./workspace-artifact-workflow";
import type { WorkspaceStore } from "./workspace";
import { hashWorkspaceContent, prepareWorkspaceScriptRun } from "./workspace-script";
import { executeWorkspaceScript } from "./workspace-script-runtime";
import { serializeWorkspaceScriptManifest } from "./workspace-script-contract";

function attachment(overrides: Partial<OperatorArtifactAttachment> = {}): OperatorArtifactAttachment {
  return {
    path: "work/brief.md",
    mediaType: "text/markdown",
    bytes: 16,
    sha256: `sha256:${"a".repeat(64)}`,
    tabularSnapshot: false,
    ...overrides
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return parseWorkspaceArtifactPlanArguments({
    summary: "Create a review report.",
    expected_effect: "Write one Markdown report; inputs remain unchanged.",
    output_path: "outputs/review-report.md",
    media_type: "text/markdown",
    script: `({ fs }) => {
  const brief = fs.readText("/inputs/workspace/work/brief.md");
  fs.writeText("/outputs/result.md", "# Review\\n\\n" + brief);
  return { written: 1 };
}`,
    assumptions: ["The brief is UTF-8 Markdown."],
    warnings: [],
    ...overrides
  }, { model: "gpt-test", responseId: "resp_artifact", inputFiles: 1 });
}

function createStore(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const store: WorkspaceStore = {
    backend: "local-storage",
    listFiles: async () => [...files.keys()].sort(),
    listBaselineFiles: async () => [],
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    readBaselineFile: async () => { throw new Error("No baseline"); },
    writeFile: async (path, content) => { files.set(path, content); },
    replaceBaseline: async () => undefined,
    replaceAll: async () => undefined,
    clear: async () => files.clear()
  };
  return { store, files };
}

describe("workspace artifact plans", () => {
  it("parses and freezes one exact output path, media type, and inert script proposal", () => {
    const parsed = plan();
    expect(parsed).toMatchObject({
      kind: "artifact-output",
      outputPath: "outputs/review-report.md",
      outputMediaType: "text/markdown",
      inputFiles: 1
    });
    expect(parsed.script).toContain("fs.writeText");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects path traversal, media mismatches, unsupported roots, extra fields, and oversized source", () => {
    expect(() => plan({ output_path: "../report.md" })).toThrow();
    expect(() => plan({ output_path: "work/report.md" })).toThrow("under outputs");
    expect(() => plan({ output_path: "outputs/report.md", media_type: "text/csv" })).toThrow("does not match");
    expect(() => plan({ network: true })).toThrow("missing or unsupported fields");
    expect(() => plan({ script: `() => ${JSON.stringify("x".repeat(25 * 1024))}` })).toThrow("too long");
  });

  it("validates structured outputs before a file proposal can be staged", async () => {
    await expect(validateWorkspaceArtifactOutputContent("application/json", "{\"ok\":true}\n")).resolves.toContain("ok");
    await expect(validateWorkspaceArtifactOutputContent("application/json", "{bad}")).rejects.toThrow("JSON output is invalid");
    await expect(validateWorkspaceArtifactOutputContent("text/csv", "Owner,Status\nAya,Review\n")).resolves.toContain("Owner");
    await expect(validateWorkspaceArtifactOutputContent("text/csv", 'Owner\n"unterminated')).rejects.toThrow("inside a quoted field");
    await expect(validateWorkspaceArtifactOutputContent("text/csv", "Owner,Value\nAya,=2+2\n")).rejects.toThrow("formula-looking cells");
    await expect(validateWorkspaceArtifactOutputContent("text/plain", "bad\0value")).rejects.toThrow("NUL byte");
  });

  it("derives manifest authority and virtual mounts entirely on the host", async () => {
    const content = "# Weekly brief\n";
    const input = attachment({ bytes: new TextEncoder().encode(content).byteLength, sha256: await hashWorkspaceContent(content) });
    const draft = createWorkspaceArtifactWorkflowDraft(plan(), [input]);
    const definition = createWorkspaceArtifactScriptDefinition(draft);

    expect(definition.manifest).toMatchObject({
      sourcePath: "scripts/artifact-review-report.js",
      inputs: [{ workspacePath: input.path, mountPath: workspaceArtifactInputMountPath(input.path), maxBytes: input.bytes }],
      outputs: [{ workspacePath: "outputs/review-report.md", mountPath: workspaceArtifactOutputMountPath("text/markdown"), required: true }]
    });
    expect(definition.manifest.limits).toMatchObject({ maxTotalInputBytes: input.bytes, maxTotalOutputBytes: 256 * 1024 });
    expect(() => createWorkspaceArtifactWorkflowDraft({ ...plan(), inputFiles: 2 }, [input])).toThrow("input count does not match");
    expect(() => createWorkspaceArtifactWorkflowDraft({ ...plan(), outputPath: "../escape.md" }, [input])).toThrow();
  });

  it("executes only against the planned input identity and produces one transient text output", async () => {
    const content = "# Weekly brief\n";
    const input = attachment({ bytes: new TextEncoder().encode(content).byteLength, sha256: await hashWorkspaceContent(content) });
    const draft = createWorkspaceArtifactWorkflowDraft(plan(), [input]);
    const definition = createWorkspaceArtifactScriptDefinition(draft);
    const { store, files } = createStore({
      [input.path]: content,
      [definition.manifest.sourcePath]: definition.source,
      [definition.manifestPath]: serializeWorkspaceScriptManifest(definition.manifest)
    });
    const snapshot = await prepareWorkspaceScriptRun(store, definition.manifest);
    expect(assertWorkspaceArtifactRunInputs(snapshot, draft)).toBe(snapshot);
    const execution = await executeWorkspaceScript(snapshot);
    expect(execution.outputs).toEqual([expect.objectContaining({
      workspacePath: "outputs/review-report.md",
      mediaType: "text/markdown",
      content: "# Review\n\n# Weekly brief\n"
    })]);
    expect(files.has("outputs/review-report.md")).toBe(false);

    files.set(input.path, "changed\n");
    const changed = await prepareWorkspaceScriptRun(store, definition.manifest);
    expect(() => assertWorkspaceArtifactRunInputs(changed, draft)).toThrow("changed after planning");
  });
});
