import "./dom-polyfill-guard";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import {
  Catalog,
  DynamicBooleanSchema,
  DynamicNumberSchema,
  DynamicStringSchema,
  DynamicValueSchema,
  spec,
  type ComponentApi,
  type FunctionApi,
  type FunctionImplementation,
  type SurfaceModel
} from "@a2ui/web_core/v1_0";
// A2UI uses the security-patched v3 compatibility API from Zod 4.
import { z } from "zod/v3";
import { downloadTextFile } from "../browser-download";
import {
  type A2uiLocalRpcEngine,
  type QuickJsTransformOutput,
  resolveEffectiveUserActivation,
  useA2uiSurfaceRpc,
  type WorkspaceDiffPreview,
  type WorkspaceFilePreview,
  type WorkspaceWriteResult
} from "./rpc-functions";

export const WASMHATCH_WORKSPACE_CATALOG_ID = "wasmhatch:workspace:v1";

export const WorkspaceDiffCardApi = {
  name: "WorkspaceDiffCard",
  schema: spec(
    z
      .object({
        path: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Target workspace file path to diff and optionally write."
        ),
        proposedContent: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Proposed full file contents to compare against the workspace."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional card heading."
        ).optional(),
        summary: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional one-line explanation of the proposed change."
        ).optional()
      })
      .describe(
        "Interactive unified diff card comparing proposed content against an OPFS workspace file, with user-activated Apply and .patch export."
      )
      .strict(),
    { mixins: [], required: ["path", "proposedContent"] }
  )
} satisfies ComponentApi;

export const QuickJsWorkbenchApi = {
  name: "QuickJsWorkbench",
  schema: spec(
    z
      .object({
        script: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Sandboxed JavaScript source (`function main(input) { ... }` or expression using `args`)."
        ).optional(),
        args: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Reactive input object passed as `input.args` (bind to form/slider paths like `$/params`)."
        ).optional(),
        targetPath: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|JSON Pointer path on the surface data model (e.g. '/sim') updated with the script output."
        ).optional(),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional label for the local compute bar."
        ).optional(),
        autoRun: DynamicBooleanSchema.describe(
          "REF:#/$defs/DynamicBoolean|Whether to re-run automatically whenever `args` changes (default true)."
        ).optional(),
        scriptPath: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional workspace `.js` file path to execute instead of inline `script`."
        ).optional(),
        inputPaths: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Optional array of workspace file paths passed as `input.files`."
        ).optional()
      })
      .describe(
        "Millisecond local QuickJS Wasm compute node that transforms bound UI parameters into surface data model updates with zero LLM round-trips."
      )
      .strict(),
    { mixins: [], required: [] }
  )
} satisfies ComponentApi;

export const WorkspaceFileCardApi = {
  name: "WorkspaceFileCard",
  schema: spec(
    z
      .object({
        path: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Workspace file path to preview."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional display heading."
        ).optional(),
        maxLines: DynamicNumberSchema.describe(
          "REF:#/$defs/DynamicNumber|Maximum preview lines (default 80)."
        ).optional()
      })
      .describe("Live preview card for an OPFS workspace file with byte count and 1-click download.")
      .strict(),
    { mixins: [], required: ["path"] }
  )
} satisfies ComponentApi;

export const RunQuickJsTransformFnApi = {
  name: "runQuickJsTransform",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  description:
    "Executes deterministic JavaScript inside WasmHatch's QuickJS Wasm sandbox and optionally writes the result into targetPath on the surface data model.",
  schema: spec(
    z.object({
      script: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Inline QuickJS source."
      ).optional(),
      args: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|JSON-serializable input arguments."
      ).optional(),
      targetPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional JSON Pointer on the surface data model to update."
      ).optional(),
      scriptPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional workspace script file path."
      ).optional(),
      inputPaths: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Optional array of workspace file paths."
      ).optional(),
      timeoutMs: DynamicNumberSchema.describe(
        "REF:#/$defs/DynamicNumber|Optional wall-clock timeout in ms (50–2000)."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const PreviewWorkspaceDiffFnApi = {
  name: "previewWorkspaceDiff",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  description: "Computes a unified diff between an existing workspace file and proposed content.",
  schema: spec(
    z.object({
      path: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Workspace file path."),
      proposedContent: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Proposed file content."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const ReadWorkspaceFileFnApi = {
  name: "readWorkspaceFile",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  description: "Reads a workspace text file preview and optionally populates targetPath.",
  schema: spec(
    z.object({
      path: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Workspace file path."),
      maxLines: DynamicNumberSchema.describe(
        "REF:#/$defs/DynamicNumber|Optional line cap."
      ).optional(),
      targetPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional JSON Pointer path on the surface data model."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const CommitWorkspaceWriteFnApi = {
  name: "commitWorkspaceWrite",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description:
    "Writes content to a workspace file after user activation, honoring Careful-mode approval and recording a revertible diff in the chat transcript.",
  schema: spec(
    z.object({
      path: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Target workspace path."),
      content: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Full file content to write.")
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const ExportWorkspacePatchFnApi = {
  name: "exportWorkspacePatch",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description: "Downloads a unified `.patch` file in the browser.",
  schema: spec(
    z.object({
      path: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Workspace file path."),
      proposedContent: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Proposed content."
      ).optional(),
      diff: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Precomputed diff.").optional(),
      fileName: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional download filename."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

function classifyDiffLine(line: string): "meta" | "hunk" | "add" | "del" | "ctx" {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function stripTargetSubtreeForKey(args: unknown, targetPath: string | undefined): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args) || !targetPath) return args;
  const clean = targetPath.trim().replace(/^\$/, "").replace(/^\//, "");
  const topSegment = clean.split("/")[0];
  if (!topSegment || !(topSegment in (args as Record<string, unknown>))) return args;
  const shallow = { ...(args as Record<string, unknown>) };
  delete shallow[topSegment];
  return shallow;
}

const WasmhatchWorkspaceDiffCard = createComponentImplementation(
  WorkspaceDiffCardApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const [preview, setPreview] = useState<WorkspaceDiffPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

    const path = typeof props.path === "string" ? props.path.trim() : "";
    const proposedContent =
      typeof props.proposedContent === "string" ? props.proposedContent : "";
    const canRead = rpc ? rpc.canUseCapability("workspace.read") : false;
    const canWrite = rpc ? rpc.canUseCapability("workspace.write") : false;

    const refreshPreview = useCallback(async () => {
      if (!rpc || !path) return;
      if (!canRead) {
        setError(t`Workspace read access is disabled for this hatchling.`);
        return;
      }
      setError(null);
      try {
        const res = await rpc.callLocalRpc<WorkspaceDiffPreview>("previewWorkspaceDiff", {
          path,
          proposedContent
        });
        setPreview(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : t`Could not compute diff preview.`);
      }
    }, [canRead, path, proposedContent, rpc]);

    useEffect(() => {
      setAppliedMessage(null);
      void refreshPreview();
    }, [refreshPreview]);

    const handleApply = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!rpc || !path || applying) return;
        const trusted = Boolean(event.nativeEvent.isTrusted);
        setApplying(true);
        setError(null);
        try {
          const result = await rpc.callLocalRpc<WorkspaceWriteResult>(
            "commitWorkspaceWrite",
            { path, content: proposedContent },
            { userActivated: trusted }
          );
          setAppliedMessage(
            result.status === "unchanged"
              ? t`${result.path} is already up to date.`
              : t`Saved ${result.path} (${result.afterBytes} bytes). Undo is available in chat.`
          );
          await refreshPreview();
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Write could not be applied.`);
        } finally {
          setApplying(false);
        }
      },
      [applying, path, proposedContent, refreshPreview, rpc]
    );

    const handleDownloadPatch = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!rpc || !path) return;
        const trusted = Boolean(event.nativeEvent.isTrusted);
        try {
          await rpc.callLocalRpc(
            "exportWorkspacePatch",
            {
              path,
              proposedContent,
              ...(preview?.diff ? { diff: preview.diff } : {})
            },
            { userActivated: trusted }
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Patch export failed.`);
        }
      },
      [path, preview?.diff, proposedContent, rpc]
    );

    const heading =
      typeof props.title === "string" && props.title.trim() ? props.title.trim() : path || t`Workspace diff`;
    const diffLines = useMemo(() => (preview?.diff ? preview.diff.split("\n") : []), [preview?.diff]);

    return (
      <div className="a2ui-diff-card">
        <div className="a2ui-diff-header">
          <div className="a2ui-diff-heading">
            <span className="a2ui-diff-title">{heading}</span>
            <code className="a2ui-diff-path">{path}</code>
          </div>
          <div className="a2ui-diff-badges">
            {preview && (
              <span
                className="a2ui-status-pill"
                data-tone={preview.unchanged ? "neutral" : preview.creates ? "accent" : "warn"}
              >
                {preview.unchanged
                  ? t`Up to date`
                  : preview.creates
                    ? t`New file (${preview.afterBytes} B)`
                    : `${preview.beforeBytes} B → ${preview.afterBytes} B`}
              </span>
            )}
          </div>
        </div>

        {typeof props.summary === "string" && props.summary.trim() && (
          <p className="a2ui-diff-summary">{props.summary.trim()}</p>
        )}

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {appliedMessage && (
          <p className="a2ui-diff-applied" role="status">
            {appliedMessage}
          </p>
        )}

        {diffLines.length > 0 && (
          <pre className="a2ui-diff-pre" tabIndex={0}>
            {diffLines.map((line, idx) => (
              <span
                key={idx}
                className="a2ui-diff-line"
                data-diff-kind={classifyDiffLine(line)}
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        )}

        <div className="a2ui-diff-actions">
          <button
            type="button"
            className="a2ui-button"
            data-variant="primary"
            disabled={applying || !canWrite || Boolean(preview?.unchanged)}
            onClick={(event) => {
              void handleApply(event);
            }}
          >
            {applying ? t`Applying…` : t`Apply to workspace`}
          </button>
          <button
            type="button"
            className="a2ui-button"
            data-variant="borderless"
            disabled={!preview}
            onClick={(event) => {
              void handleDownloadPatch(event);
            }}
          >
            {t`Download .patch`}
          </button>
        </div>
      </div>
    );
  }
);

const WasmhatchQuickJsWorkbench = createComponentImplementation(
  QuickJsWorkbenchApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const [running, setRunning] = useState(false);
    const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const burstGuardRef = useRef<{ windowStart: number; count: number }>({
      windowStart: 0,
      count: 0
    });

    const script = typeof props.script === "string" ? props.script : "";
    const scriptPath = typeof props.scriptPath === "string" ? props.scriptPath : "";
    const targetPath = typeof props.targetPath === "string" ? props.targetPath : undefined;
    const autoRun = props.autoRun !== false;
    const inputPaths = Array.isArray(props.inputPaths) ? props.inputPaths : undefined;

    const executeTransform = useCallback(async () => {
      if (!rpc) return;
      if (!script.trim() && !scriptPath.trim()) return;
      if (!rpc.canUseCapability("workspace.script")) {
        setError(t`Sandbox scripting capability is disabled for this hatchling.`);
        return;
      }
      setRunning(true);
      setError(null);
      try {
        const output = await rpc.callLocalRpc<QuickJsTransformOutput>("runQuickJsTransform", {
          ...(script ? { script } : {}),
          ...(scriptPath ? { scriptPath } : {}),
          args: props.args ?? null,
          ...(targetPath ? { targetPath } : {}),
          ...(inputPaths ? { inputPaths } : {})
        });
        if (!output.stale) {
          setLastDurationMs(output.durationMs);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t`QuickJS transform failed.`);
      } finally {
        setRunning(false);
      }
    }, [inputPaths, props.args, rpc, script, scriptPath, targetPath]);

    const autoRunKey = useMemo(() => {
      const sanitizedArgs = stripTargetSubtreeForKey(props.args, targetPath);
      try {
        return JSON.stringify({
          script,
          scriptPath,
          targetPath,
          inputPaths,
          args: sanitizedArgs
        });
      } catch {
        return String(Date.now());
      }
    }, [inputPaths, props.args, script, scriptPath, targetPath]);

    useEffect(() => {
      if (!autoRun) return;
      const now = Date.now();
      if (now - burstGuardRef.current.windowStart > 300) {
        burstGuardRef.current = { windowStart: now, count: 1 };
      } else {
        burstGuardRef.current.count += 1;
        if (burstGuardRef.current.count > 8) return;
      }
      const timer = setTimeout(() => {
        void executeTransform();
      }, 16);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, autoRunKey]);

    const title =
      typeof props.title === "string" && props.title.trim()
        ? props.title.trim()
        : t`Local QuickJS sandbox`;

    return (
      <div className="a2ui-workbench-card">
        <div className="a2ui-workbench-bar">
          <div className="a2ui-workbench-title-group">
            <span className="a2ui-workbench-title">{title}</span>
            <span className="a2ui-status-pill" data-tone={error ? "error" : "accent"}>
              {running
                ? t`Computing…`
                : lastDurationMs !== null
                  ? t`QuickJS · ${lastDurationMs} ms`
                  : t`QuickJS ready`}
            </span>
          </div>
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="borderless"
            disabled={running}
            onClick={() => {
              void executeTransform();
            }}
          >
            {t`Recalculate`}
          </button>
        </div>

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {(script.trim() || scriptPath.trim()) && (
          <details className="a2ui-disclosure">
            <summary className="a2ui-disclosure-summary">
              {scriptPath.trim() ? t`Script (${scriptPath.trim()})` : t`Inspect sandbox formula`}
            </summary>
            <div className="a2ui-disclosure-body">
              <pre className="a2ui-code-preview">{script.trim() || scriptPath.trim()}</pre>
            </div>
          </details>
        )}
      </div>
    );
  }
);

const WasmhatchWorkspaceFileCard = createComponentImplementation(
  WorkspaceFileCardApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
    const [error, setError] = useState<string | null>(null);

    const path = typeof props.path === "string" ? props.path.trim() : "";
    const maxLines =
      typeof props.maxLines === "number" && Number.isFinite(props.maxLines)
        ? props.maxLines
        : 80;

    useEffect(() => {
      if (!rpc || !path) return;
      if (!rpc.canUseCapability("workspace.read")) {
        setError(t`Workspace read access is disabled for this hatchling.`);
        return;
      }
      let cancelled = false;
      setError(null);
      void rpc
        .callLocalRpc<WorkspaceFilePreview>("readWorkspaceFile", { path, maxLines })
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : t`File could not be read.`);
          }
        });
      return () => {
        cancelled = true;
      };
    }, [maxLines, path, rpc]);

    const handleDownload = useCallback(
      (event: MouseEvent<HTMLButtonElement>) => {
        if (!event.nativeEvent.isTrusted || !preview) return;
        downloadTextFile(preview.path, preview.content);
      },
      [preview]
    );

    const heading =
      typeof props.title === "string" && props.title.trim() ? props.title.trim() : path;

    return (
      <div className="a2ui-file-card">
        <div className="a2ui-diff-header">
          <div className="a2ui-diff-heading">
            <span className="a2ui-diff-title">{heading}</span>
            {heading !== path && <code className="a2ui-diff-path">{path}</code>}
          </div>
          {preview && (
            <div className="a2ui-diff-badges">
              <span className="a2ui-status-pill" data-tone="neutral">
                {t`${preview.totalLines} lines · ${preview.byteLength} B`}
              </span>
              <button
                type="button"
                className="a2ui-button a2ui-button-compact"
                data-variant="borderless"
                onClick={handleDownload}
              >
                {t`Download`}
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <pre className="a2ui-code-preview" tabIndex={0}>
            {preview.content}
          </pre>
        )}
      </div>
    );
  }
);

export function createWasmhatchWorkspaceCatalog(
  rpcEngine: A2uiLocalRpcEngine
): Catalog<ReactCatalogComponent> {
  const runQuickJsTransformImpl: FunctionImplementation = {
    ...RunQuickJsTransformFnApi,
    execute: async (args, context, abortSignal) => {
      const surface = context.surface as SurfaceModel<ReactCatalogComponent> | undefined;
      return rpcEngine.runQuickJsTransform(args, surface, {
        signal: abortSignal
      });
    }
  };

  const previewWorkspaceDiffImpl: FunctionImplementation = {
    ...PreviewWorkspaceDiffFnApi,
    execute: async (args) => rpcEngine.previewWorkspaceDiff(args)
  };

  const readWorkspaceFileImpl: FunctionImplementation = {
    ...ReadWorkspaceFileFnApi,
    execute: async (args, context) => {
      const surface = context.surface as SurfaceModel<ReactCatalogComponent> | undefined;
      return rpcEngine.readWorkspaceFile(args, surface);
    }
  };

  const commitWorkspaceWriteImpl: FunctionImplementation = {
    ...CommitWorkspaceWriteFnApi,
    execute: async (args, context, abortSignal) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.commitWorkspaceWrite(args, {
        userActivated,
        signal: abortSignal
      });
    }
  };

  const exportWorkspacePatchImpl: FunctionImplementation = {
    ...ExportWorkspacePatchFnApi,
    execute: async (args, context) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.exportWorkspacePatch(args, { userActivated });
    }
  };

  return new Catalog<ReactCatalogComponent>(
    WASMHATCH_WORKSPACE_CATALOG_ID,
    "1.0",
    [WasmhatchWorkspaceDiffCard, WasmhatchQuickJsWorkbench, WasmhatchWorkspaceFileCard],
    [
      runQuickJsTransformImpl,
      previewWorkspaceDiffImpl,
      readWorkspaceFileImpl,
      commitWorkspaceWriteImpl,
      exportWorkspacePatchImpl
    ],
    {
      schemaUri: "https://json-schema.org/draft/2020-12/schema",
      schemaId: WASMHATCH_WORKSPACE_CATALOG_ID,
      title: "WasmHatch Workspace & QuickJS Catalog",
      description:
        "OPFS workspace diff/preview cards and QuickJS Wasm millisecond local compute nodes.",
      instructions:
        "Use the active workspace components and functions above to preview OPFS files, review unified diffs before applying changes, or recompute bound surface paths locally with zero model round-trips.",
      declaredProtocolVersion: "1.0"
    }
  );
}
