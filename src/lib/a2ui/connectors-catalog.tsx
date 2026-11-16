import "./dom-polyfill-guard";
import { useCallback, useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import {
  Catalog,
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
import type { PickedDriveFile } from "../google-picker";
import {
  type A2uiLocalRpcEngine,
  type GooglePickerRpcResult,
  type GoogleSheetCommitResult,
  type GoogleSheetRollbackResult,
  resolveEffectiveUserActivation,
  type SlackPreviewSendResult,
  useA2uiSurfaceRpc
} from "./rpc-functions";
import { detectFormulaInjection } from "./tabular-utils";

export const WASMHATCH_CONNECTORS_CATALOG_ID = "wasmhatch:connectors:v1";
const SLACK_MAX_CHARS = 40_000;
const MAX_PREVIEW_ROWS = 12;
const MAX_PREVIEW_COLS = 8;

export const GoogleSheetRangeCardApi = {
  name: "GoogleSheetRangeCard",
  schema: spec(
    z
      .object({
        spreadsheetId: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Google Spreadsheet ID created or handed over in this session."
        ),
        range: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Target A1 range (e.g. 'Sheet1!A1:C5')."
        ),
        values: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|2D array of proposed cell values (`string[][]`)."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional heading for the Google Sheet preview card."
        ).optional(),
        sheetUrl: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional `https://docs.google.com/spreadsheets/...` link."
        ).optional()
      })
      .describe(
        "Interactive Google Sheet cell-range write preview with formula-injection inspection, user-activated commit, and 1-click undo rollback."
      )
      .strict(),
    { mixins: [], required: ["spreadsheetId", "range", "values"] }
  )
} satisfies ComponentApi;

export const GooglePickerHandoverCardApi = {
  name: "GooglePickerHandoverCard",
  schema: spec(
    z
      .object({
        reason: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Plain-language explanation of why the agent needs specific Google Drive files."
        ).optional(),
        targetPath: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional JSON Pointer on the surface DataModel to populate with the picked file descriptors."
        ).optional(),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional heading for the handover card."
        ).optional()
      })
      .describe(
        "Per-file Google Drive consent card (`drive.file` scope) that opens Google's own file picker on user click and populates the selected file IDs."
      )
      .strict(),
    { mixins: [], required: [] }
  )
} satisfies ComponentApi;

export const SlackMessagePreviewCardApi = {
  name: "SlackMessagePreviewCard",
  schema: spec(
    z
      .object({
        text: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Proposed Slack message body (supports Slack mrkdwn)."
        ),
        channel: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional Slack channel ID or `#name` when connected via bot token."
        ).optional(),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional card heading."
        ).optional()
      })
      .describe(
        "Editable Slack message preview card with scope-boundary notice, character counter, and user-activated Send."
      )
      .strict(),
    { mixins: [], required: ["text"] }
  )
} satisfies ComponentApi;

export const CommitGoogleSheetValuesFnApi = {
  name: "commitGoogleSheetValues",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description:
    "Writes a 2D cell array to a Google Sheet range (`RAW` input mode) after snapshotting prior cells so the user can undo in one click.",
  schema: spec(
    z.object({
      spreadsheetId: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Spreadsheet ID."),
      range: DynamicStringSchema.describe("REF:#/$defs/DynamicString|A1 cell range."),
      values: DynamicValueSchema.describe("REF:#/$defs/DynamicValue|2D array of cell strings.")
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const RollbackGoogleSheetValuesFnApi = {
  name: "rollbackGoogleSheetValues",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description: "Restores the pre-write cell snapshot captured by `commitGoogleSheetValues`.",
  schema: spec(
    z.object({
      rollbackId: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Rollback identifier returned by `commitGoogleSheetValues`."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const PickGoogleDriveFilesFnApi = {
  name: "pickGoogleDriveFiles",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description:
    "Opens Google's file picker for `drive.file` per-file handover and optionally stores the picked file descriptors at `targetPath`.",
  schema: spec(
    z.object({
      reason: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional explanation shown before opening the picker."
      ).optional(),
      targetPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional JSON Pointer on the surface DataModel."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const SendSlackPreviewMessageFnApi = {
  name: "sendSlackPreviewMessage",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description:
    "Delivers a reviewed Slack message through the connected Slack bot token or Incoming Webhook.",
  schema: spec(
    z.object({
      text: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Slack mrkdwn message body."),
      channel: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional Slack channel ID or `#name`."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

function normalizeMatrix(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
}

function isSafeGoogleDocsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "https:" && parsed.hostname === "docs.google.com") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

const WasmhatchGoogleSheetRangeCard = createComponentImplementation(
  GoogleSheetRangeCardApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [commitState, setCommitState] = useState<GoogleSheetCommitResult | null>(null);
    const [reverted, setReverted] = useState(false);

    const spreadsheetId =
      typeof props.spreadsheetId === "string" ? props.spreadsheetId.trim() : "";
    const range = typeof props.range === "string" ? props.range.trim() : "";
    const matrix = useMemo(() => normalizeMatrix(props.values), [props.values]);
    const safeUrl = isSafeGoogleDocsUrl(props.sheetUrl);
    const canGoogle = rpc ? rpc.canUseCapability("google") : false;

    const totalCells = useMemo(
      () => matrix.reduce((acc, row) => acc + row.length, 0),
      [matrix]
    );
    const formulaCount = useMemo(() => {
      let count = 0;
      for (const row of matrix) {
        for (const cell of row) {
          if (detectFormulaInjection(cell)) count += 1;
        }
      }
      return count;
    }, [matrix]);

    const handleCommit = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!event.nativeEvent.isTrusted || !rpc || busy || !spreadsheetId || !range) return;
        setBusy(true);
        setError(null);
        setReverted(false);
        try {
          const res = await rpc.callLocalRpc<GoogleSheetCommitResult>(
            "commitGoogleSheetValues",
            { spreadsheetId, range, values: matrix },
            { userActivated: true }
          );
          setCommitState(res);
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Could not update Google Sheet.`);
        } finally {
          setBusy(false);
        }
      },
      [busy, matrix, range, rpc, spreadsheetId]
    );

    const handleRollback = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!event.nativeEvent.isTrusted || !rpc || busy || !commitState) return;
        setBusy(true);
        setError(null);
        try {
          await rpc.callLocalRpc<GoogleSheetRollbackResult>(
            "rollbackGoogleSheetValues",
            { rollbackId: commitState.rollbackId },
            { userActivated: true }
          );
          setCommitState(null);
          setReverted(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Could not undo Google Sheet write.`);
        } finally {
          setBusy(false);
        }
      },
      [busy, commitState, rpc]
    );

    const heading =
      typeof props.title === "string" && props.title.trim()
        ? props.title.trim()
        : t`Google Sheet preview`;
    const previewRows = matrix.slice(0, MAX_PREVIEW_ROWS);

    return (
      <section className="a2ui-connector-card" aria-label={heading}>
        <div className="a2ui-diff-header">
          <div className="a2ui-diff-heading">
            <span className="a2ui-diff-title">{heading}</span>
            <code className="a2ui-diff-path">{range}</code>
          </div>
          <div className="a2ui-diff-badges">
            <span className="a2ui-status-pill" data-tone="neutral">
              {t`${matrix.length} rows · ${totalCells} cells`}
            </span>
            {formulaCount > 0 && (
              <span className="a2ui-formula-alert-pill">
                {t`${formulaCount} formula-prefixed cells (written as literal text)`}
              </span>
            )}
          </div>
        </div>

        <p className="a2ui-diff-summary">
          {t`Scope: drive.file — writes RAW literal values only to spreadsheets created or handed over in this session.`}
          {safeUrl && (
            <>
              {" · "}
              <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                {t`Open sheet`}
              </a>
            </>
          )}
        </p>

        {previewRows.length > 0 && (
          <div className="a2ui-connector-table-wrap">
            <table className="a2ui-mini-table">
              <tbody>
                {previewRows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.slice(0, MAX_PREVIEW_COLS).map((cell, cIdx) => (
                      <td key={cIdx}>
                        {detectFormulaInjection(cell) && (
                          <span className="a2ui-formula-badge">{t`Literal`}</span>
                        )}
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {commitState && (
          <p className="a2ui-diff-applied" role="status">
            {t`Updated ${commitState.updatedCells} cells in ${commitState.range}.`}
          </p>
        )}

        {reverted && (
          <p className="a2ui-diff-summary" role="status">
            {t`Restored previous cell values in ${range}.`}
          </p>
        )}

        <div className="a2ui-diff-actions">
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="primary"
            disabled={busy || !canGoogle || matrix.length === 0 || !spreadsheetId || !range}
            onClick={(e) => {
              void handleCommit(e);
            }}
          >
            {busy ? t`Writing…` : t`Write to Google Sheet`}
          </button>
          {commitState && (
            <button
              type="button"
              className="a2ui-button a2ui-button-compact"
              disabled={busy}
              onClick={(e) => {
                void handleRollback(e);
              }}
            >
              {t`Undo write`}
            </button>
          )}
        </div>
      </section>
    );
  }
);

const WasmhatchGooglePickerHandoverCard = createComponentImplementation(
  GooglePickerHandoverCardApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pickedFiles, setPickedFiles] = useState<PickedDriveFile[] | null>(null);

    const canGoogle = rpc ? rpc.canUseCapability("google") : false;
    const heading =
      typeof props.title === "string" && props.title.trim()
        ? props.title.trim()
        : t`Share Google Drive files`;
    const reason =
      typeof props.reason === "string" && props.reason.trim()
        ? props.reason.trim()
        : t`Choose specific Google Drive files to grant access for this task.`;
    const targetPath =
      typeof props.targetPath === "string" && props.targetPath.trim()
        ? props.targetPath.trim()
        : undefined;

    const handlePick = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!event.nativeEvent.isTrusted || !rpc || busy) return;
        setBusy(true);
        setError(null);
        try {
          const res = await rpc.callLocalRpc<GooglePickerRpcResult>(
            "pickGoogleDriveFiles",
            { reason, ...(targetPath ? { targetPath } : {}) },
            { userActivated: true }
          );
          if (!res.cancelled) {
            setPickedFiles(res.picked);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Could not open Google Drive picker.`);
        } finally {
          setBusy(false);
        }
      },
      [busy, reason, rpc, targetPath]
    );

    return (
      <section className="a2ui-connector-card" aria-label={heading}>
        <div className="a2ui-diff-header">
          <span className="a2ui-diff-title">{heading}</span>
          <span className="a2ui-status-pill" data-tone="neutral">
            drive.file
          </span>
        </div>
        <p className="a2ui-diff-summary">{reason}</p>
        <p className="a2ui-diff-summary">
          {t`WasmHatch cannot browse your Drive on its own — only the exact files you select in Google's picker are shared.`}
        </p>

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {pickedFiles && (
          <div className="a2ui-picked-files" role="status">
            <strong>{t`Shared files (${pickedFiles.length}):`}</strong>
            <ul>
              {pickedFiles.map((file) => (
                <li key={file.id}>
                  <span>{file.name}</span>{" "}
                  <code className="a2ui-diff-path">{file.id}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="a2ui-diff-actions">
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="primary"
            disabled={busy || !canGoogle}
            onClick={(e) => {
              void handlePick(e);
            }}
          >
            {busy ? t`Opening picker…` : t`Choose Drive files…`}
          </button>
        </div>
      </section>
    );
  }
);

const WasmhatchSlackMessagePreviewCard = createComponentImplementation(
  SlackMessagePreviewCardApi,
  ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const textareaId = useId();
    const initialText = typeof props.text === "string" ? props.text : "";
    const [draftText, setDraftText] = useState(initialText);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentSummary, setSentSummary] = useState<string | null>(null);

    useEffect(() => {
      setDraftText(initialText);
      setSentSummary(null);
    }, [initialText]);

    const channel = typeof props.channel === "string" ? props.channel.trim() : "";
    const canSlack = rpc ? rpc.canUseCapability("slack") : false;
    const heading =
      typeof props.title === "string" && props.title.trim()
        ? props.title.trim()
        : t`Slack message preview`;
    const overLimit = draftText.length > SLACK_MAX_CHARS;

    const handleSend = useCallback(
      async (event: MouseEvent<HTMLButtonElement>) => {
        if (!event.nativeEvent.isTrusted || !rpc || busy || !draftText.trim() || overLimit) return;
        setBusy(true);
        setError(null);
        try {
          const res = await rpc.callLocalRpc<SlackPreviewSendResult>(
            "sendSlackPreviewMessage",
            { text: draftText, ...(channel ? { channel } : {}) },
            { userActivated: true }
          );
          setSentSummary(res.summary);
        } catch (err) {
          setError(err instanceof Error ? err.message : t`Could not send Slack message.`);
        } finally {
          setBusy(false);
        }
      },
      [busy, channel, draftText, overLimit, rpc]
    );

    return (
      <section className="a2ui-connector-card" aria-label={heading}>
        <div className="a2ui-diff-header">
          <div className="a2ui-diff-heading">
            <span className="a2ui-diff-title">{heading}</span>
            {channel && <code className="a2ui-diff-path">{channel}</code>}
          </div>
          <span
            className="a2ui-status-pill"
            data-tone={overLimit ? "error" : "neutral"}
          >
            {`${draftText.length.toLocaleString()} / ${SLACK_MAX_CHARS.toLocaleString()}`}
          </span>
        </div>

        <p className="a2ui-diff-summary">
          {t`Write-only preview: posts to your connected Slack channel or webhook and never reads message history.`}
        </p>

        <div className="a2ui-field">
          <label htmlFor={textareaId} className="a2ui-sr-only">
            {heading}
          </label>
          <textarea
            id={textareaId}
            className="a2ui-textarea"
            rows={4}
            value={draftText}
            onChange={(e) => {
              setDraftText(e.target.value);
              setSentSummary(null);
            }}
          />
        </div>

        {error && (
          <p className="a2ui-field-error" role="alert">
            {error}
          </p>
        )}

        {sentSummary && (
          <p className="a2ui-diff-applied" role="status">
            {sentSummary}
          </p>
        )}

        <div className="a2ui-diff-actions">
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="primary"
            disabled={busy || !canSlack || !draftText.trim() || overLimit}
            onClick={(e) => {
              void handleSend(e);
            }}
          >
            {busy ? t`Sending…` : t`Send to Slack`}
          </button>
        </div>
      </section>
    );
  }
);

export function createWasmhatchConnectorsCatalog(
  rpcEngine: A2uiLocalRpcEngine
): Catalog<ReactCatalogComponent> {
  const commitSheetImpl: FunctionImplementation = {
    ...CommitGoogleSheetValuesFnApi,
    execute: async (args, context, abortSignal) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.commitGoogleSheetValues(args, {
        userActivated,
        signal: abortSignal
      });
    }
  };

  const rollbackSheetImpl: FunctionImplementation = {
    ...RollbackGoogleSheetValuesFnApi,
    execute: async (args, context, abortSignal) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.rollbackGoogleSheetValues(args, {
        userActivated,
        signal: abortSignal
      });
    }
  };

  const pickDriveFilesImpl: FunctionImplementation = {
    ...PickGoogleDriveFilesFnApi,
    execute: async (args, context, abortSignal) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      const surface = context.surface as SurfaceModel<ReactCatalogComponent> | undefined;
      return rpcEngine.pickGoogleDriveFiles(args, surface, {
        userActivated,
        signal: abortSignal
      });
    }
  };

  const sendSlackImpl: FunctionImplementation = {
    ...SendSlackPreviewMessageFnApi,
    execute: async (args, context, abortSignal) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.sendSlackPreviewMessage(args, {
        userActivated,
        signal: abortSignal
      });
    }
  };

  return new Catalog<ReactCatalogComponent>(
    WASMHATCH_CONNECTORS_CATALOG_ID,
    "1.0",
    [
      WasmhatchGoogleSheetRangeCard,
      WasmhatchGooglePickerHandoverCard,
      WasmhatchSlackMessagePreviewCard
    ],
    [commitSheetImpl, rollbackSheetImpl, pickDriveFilesImpl, sendSlackImpl],
    {
      schemaUri: "https://json-schema.org/draft/2020-12/schema",
      schemaId: WASMHATCH_CONNECTORS_CATALOG_ID,
      title: "WasmHatch Google & Slack Connectors Catalog",
      description:
        "Preview-before-commit cards for Google Sheets (`drive.file` scope with 1-click rollback), Google Picker file handover, and Slack messages.",
      instructions:
        "When Google or Slack connectors are active and the user benefits from reviewing or editing cells/messages before committing, emit `GoogleSheetRangeCard`, `GooglePickerHandoverCard`, or `SlackMessagePreviewCard`.",
      declaredProtocolVersion: "1.0"
    }
  );
}

