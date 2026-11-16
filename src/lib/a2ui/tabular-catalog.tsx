import "./dom-polyfill-guard";
import { useCallback, useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import {
  Catalog,
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
import {
  type A2uiLocalRpcEngine,
  resolveEffectiveUserActivation,
  useA2uiSurfaceRpc
} from "./rpc-functions";
import {
  normalizeTabularDataset,
  profileTabularDataset,
  type NormalizedTabularRow,
  type TabularCellValue,
  type TabularColumnDef
} from "./tabular-utils";

export const WASMHATCH_TABULAR_CATALOG_ID = "wasmhatch:tabular:v1";

const DEFAULT_PAGE_SIZE = 25;

export const DataGridApi = {
  name: "DataGrid",
  schema: spec(
    z
      .object({
        rows: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Tabular dataset: array of row objects, { columns, rows } object, or CSV/TSV text."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Accessible caption and header title for the data grid."
        ).optional(),
        columns: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Optional explicit column definitions ([{ key, label, type }] or string keys)."
        ).optional(),
        pageSize: DynamicNumberSchema.describe(
          "REF:#/$defs/DynamicNumber|Rows per page (5 to 200, default 25)."
        ).optional(),
        selectionPath: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional JSON Pointer path on the surface data model updated when a row is selected."
        ).optional(),
        exportFileName: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional filename for safe CSV export (default 'table-export.csv')."
        ).optional()
      })
      .describe(
        "Interactive sortable, filterable tabular grid with formula-injection warnings and safe CSV export."
      )
      .strict(),
    { mixins: [], required: ["rows"] }
  )
} satisfies ComponentApi;

export const ColumnProfilerApi = {
  name: "ColumnProfiler",
  schema: spec(
    z
      .object({
        rows: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Tabular dataset to profile across columns."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Optional heading for the column profile card."
        ).optional()
      })
      .describe(
        "Summarizes row counts, missing values, distinct counts, numeric ranges, and formula-injection warnings."
      )
      .strict(),
    { mixins: [], required: ["rows"] }
  )
} satisfies ComponentApi;

export const LoadWorkspaceTableFnApi = {
  name: "loadWorkspaceTable",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  description:
    "Reads and parses a workspace CSV, TSV, JSON, or JSONL file into columns, rows, and column profile statistics, optionally writing to targetPath on the surface data model.",
  schema: spec(
    z.object({
      path: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Workspace file path to load."),
      targetPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional JSON Pointer path on the surface data model to populate."
      ).optional(),
      maxRows: DynamicNumberSchema.describe(
        "REF:#/$defs/DynamicNumber|Optional maximum rows to read (up to 5000)."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const ExportSafeCsvFnApi = {
  name: "exportSafeCsv",
  returnType: "object",
  allowedCallers: "rendererOrAgent",
  requiresUserActivation: true,
  description:
    "Downloads a CSV file in the browser while neutralizing spreadsheet formula-injection cells.",
  schema: spec(
    z.object({
      rows: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Dataset rows or table object to export."
      ),
      fileName: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Download filename (e.g. 'clean-report.csv')."
      ).optional(),
      columns: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Optional column definitions."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

function formatCellDisplay(value: TabularCellValue): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function compareCells(
  a: TabularCellValue,
  b: TabularCellValue,
  colType: TabularColumnDef["type"],
  direction: "ascending" | "descending",
  collator: Intl.Collator
): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const factor = direction === "ascending" ? 1 : -1;
  if (colType === "number") {
    const numA = typeof a === "number" ? a : Number(a);
    const numB = typeof b === "number" ? b : Number(b);
    if (Number.isFinite(numA) && Number.isFinite(numB)) {
      return factor * (numA - numB);
    }
  }
  return factor * collator.compare(String(a), String(b));
}

const WasmhatchDataGrid = createComponentImplementation(DataGridApi, ({ props, context }) => {
  const captionId = useId();
  const searchInputId = useId();
  const rpc = useA2uiSurfaceRpc();

  const [filterText, setFilterText] = useState("");
  const [sortState, setSortState] = useState<{
    key: string;
    direction: "ascending" | "descending";
  } | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const [page, setPage] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  const dataset = useMemo(
    () => normalizeTabularDataset(props.rows, props.columns),
    [props.columns, props.rows]
  );

  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    []
  );

  const pageSize = useMemo(() => {
    const raw =
      typeof props.pageSize === "number" && Number.isFinite(props.pageSize)
        ? Math.floor(props.pageSize)
        : DEFAULT_PAGE_SIZE;
    return Math.max(5, Math.min(200, raw));
  }, [props.pageSize]);

  const filteredRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return dataset.rows;
    return dataset.rows.filter((row) =>
      dataset.columns.some((col) => {
        const val = row.cells[col.key];
        return val !== null && val !== undefined && String(val).toLowerCase().includes(q);
      })
    );
  }, [dataset.columns, dataset.rows, filterText]);

  const sortedRows = useMemo(() => {
    if (!sortState) return filteredRows;
    const col = dataset.columns.find((c) => c.key === sortState.key);
    if (!col) return filteredRows;
    return [...filteredRows].sort((rowA, rowB) =>
      compareCells(
        rowA.cells[col.key],
        rowB.cells[col.key],
        col.type,
        sortState.direction,
        collator
      )
    );
  }, [collator, dataset.columns, filteredRows, sortState]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));

  useEffect(() => {
    if (page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  const visibleRows = useMemo(
    () => sortedRows.slice(page * pageSize, (page + 1) * pageSize),
    [page, pageSize, sortedRows]
  );

  const handleSort = useCallback(
    (col: TabularColumnDef) => {
      const nextDirection: "ascending" | "descending" =
        sortState?.key === col.key && sortState.direction === "ascending"
          ? "descending"
          : "ascending";
      setSortState({ key: col.key, direction: nextDirection });
      setPage(0);
      setStatusAnnouncement(
        t`Sorted by ${col.label}, ${nextDirection}, ${filteredRows.length} rows`
      );
    },
    [filteredRows.length, sortState]
  );

  const selectionPointer = useMemo(() => {
    if (typeof props.selectionPath !== "string" || !props.selectionPath.trim()) return null;
    const raw = props.selectionPath.trim().replace(/^\$/, "");
    return raw.startsWith("/") ? raw : `/${raw}`;
  }, [props.selectionPath]);

  const handleSelectRow = useCallback(
    (row: NormalizedTabularRow) => {
      setSelectedRowIndex(row.rowIndex);
      if (selectionPointer) {
        context.dataContext.set(selectionPointer, { ...row.cells });
      }
    },
    [context.dataContext, selectionPointer]
  );

  const handleExportCsv = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      const trusted = Boolean(event.nativeEvent.isTrusted);
      const fileName =
        typeof props.exportFileName === "string" && props.exportFileName.trim()
          ? props.exportFileName.trim()
          : "table-export.csv";
      try {
        if (rpc) {
          await rpc.callLocalRpc(
            "exportSafeCsv",
            {
              rows: sortedRows.map((r) => r.cells),
              columns: dataset.columns,
              fileName
            },
            { userActivated: trusted }
          );
        }
        setExportFeedback(t`Exported ${sortedRows.length} rows`);
      } catch (err) {
        setExportFeedback(err instanceof Error ? err.message : t`Export blocked`);
      }
    },
    [dataset.columns, props.exportFileName, rpc, sortedRows]
  );

  const gridTitle =
    typeof props.title === "string" && props.title.trim() ? props.title.trim() : t`Data table`;
  const formulaCount = dataset.formulaWarnings.length;

  return (
    <div className="a2ui-datagrid-card">
      <search className="a2ui-datagrid-toolbar" aria-label={gridTitle}>
        <div className="a2ui-datagrid-search-wrap">
          <label htmlFor={searchInputId} className="a2ui-sr-only">
            {t`Filter rows`}
          </label>
          <input
            id={searchInputId}
            type="search"
            className="a2ui-input a2ui-datagrid-search"
            value={filterText}
            placeholder={t`Filter rows…`}
            onChange={(e) => {
              setFilterText(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="a2ui-datagrid-meta">
          <span className="a2ui-datagrid-count">
            {filteredRows.length === dataset.totalRows
              ? t`${dataset.totalRows} rows`
              : t`${filteredRows.length} of ${dataset.totalRows} rows`}
          </span>
          {formulaCount > 0 && (
            <span className="a2ui-formula-alert-pill" role="status">
              {t`${formulaCount} formula cells neutralized on export`}
            </span>
          )}
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="borderless"
            disabled={sortedRows.length === 0}
            onClick={(event) => {
              void handleExportCsv(event);
            }}
          >
            {t`Export safe CSV`}
          </button>
        </div>
      </search>

      {exportFeedback && (
        <p className="a2ui-datagrid-feedback" role="status">
          {exportFeedback}
        </p>
      )}

      <div className="a2ui-sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </div>

      {dataset.columns.length === 0 ? (
        <p className="a2ui-datagrid-empty">{t`No columns or rows available.`}</p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={captionId}
          className="a2ui-datagrid-wrapper"
        >
          <table className="a2ui-datagrid-table">
            <caption id={captionId} className="a2ui-datagrid-caption">
              {gridTitle}
              {dataset.truncated ? ` (${t`showing first ${dataset.rows.length} rows`})` : ""}
            </caption>
            <thead>
              <tr>
                {dataset.columns.map((col) => {
                  const isSorted = sortState?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      data-type={col.type}
                      aria-sort={isSorted ? sortState.direction : undefined}
                    >
                      <button
                        type="button"
                        className="a2ui-datagrid-sort-btn"
                        onClick={() => handleSort(col)}
                      >
                        <span className="a2ui-datagrid-col-label">{col.label}</span>
                        <span className="a2ui-datagrid-sort-icon" aria-hidden="true" />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={dataset.columns.length} className="a2ui-datagrid-empty-cell">
                    {t`No matching rows.`}
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => {
                  const isSelected = selectedRowIndex === row.rowIndex;
                  return (
                    <tr
                      key={row.rowIndex}
                      data-selectable={selectionPointer ? "true" : undefined}
                      data-selected={isSelected ? "true" : undefined}
                      onClick={selectionPointer ? () => handleSelectRow(row) : undefined}
                    >
                      {dataset.columns.map((col, colIdx) => {
                        const val = row.cells[col.key];
                        const hasFormula = row.formulaColumns.has(col.key);
                        const cellContent = (
                          <span className="a2ui-datagrid-cell-inner">
                            {hasFormula && (
                              <span
                                className="a2ui-formula-badge"
                                title={t`Starts with a spreadsheet formula character`}
                              >
                                {t`Formula`}
                              </span>
                            )}
                            <span className="a2ui-datagrid-cell-text">
                              {formatCellDisplay(val)}
                            </span>
                          </span>
                        );
                        if (colIdx === 0 && col.type !== "number") {
                          return (
                            <th key={col.key} scope="row" data-formula={hasFormula || undefined}>
                              {cellContent}
                            </th>
                          );
                        }
                        return (
                          <td
                            key={col.key}
                            data-type={col.type}
                            data-formula={hasFormula || undefined}
                          >
                            {cellContent}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="a2ui-datagrid-pagination">
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="borderless"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t`Previous`}
          </button>
          <span className="a2ui-datagrid-page-indicator">
            {t`Page ${page + 1} of ${totalPages}`}
          </span>
          <button
            type="button"
            className="a2ui-button a2ui-button-compact"
            data-variant="borderless"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            {t`Next`}
          </button>
        </div>
      )}
    </div>
  );
});

const WasmhatchColumnProfiler = createComponentImplementation(ColumnProfilerApi, ({ props }) => {
  const dataset = useMemo(() => normalizeTabularDataset(props.rows), [props.rows]);
  const profiles = useMemo(() => profileTabularDataset(dataset), [dataset]);
  const heading =
    typeof props.title === "string" && props.title.trim()
      ? props.title.trim()
      : t`Dataset profile`;

  return (
    <div className="a2ui-profiler-card">
      <div className="a2ui-profiler-header">
        <span className="a2ui-profiler-title">{heading}</span>
        <div className="a2ui-profiler-kpis">
          <span className="a2ui-kpi-chip">{t`${dataset.totalRows} rows`}</span>
          <span className="a2ui-kpi-chip">{t`${dataset.columns.length} columns`}</span>
          {dataset.formulaWarnings.length > 0 && (
            <span className="a2ui-formula-alert-pill">
              {t`${dataset.formulaWarnings.length} formula warnings`}
            </span>
          )}
        </div>
      </div>

      {profiles.length > 0 && (
        <details className="a2ui-disclosure" open>
          <summary className="a2ui-disclosure-summary">
            {t`Column statistics (${profiles.length})`}
          </summary>
          <div className="a2ui-disclosure-body">
            <table className="a2ui-mini-table">
              <thead>
                <tr>
                  <th scope="col">{t`Column`}</th>
                  <th scope="col">{t`Type`}</th>
                  <th scope="col">{t`Distinct`}</th>
                  <th scope="col">{t`Missing`}</th>
                  <th scope="col">{t`Range / Mean`}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((col) => (
                  <tr key={col.key}>
                    <td>
                      <strong>{col.label}</strong>
                      {col.formulaWarningCount > 0 && (
                        <span className="a2ui-formula-badge">
                          {t`${col.formulaWarningCount} formula`}
                        </span>
                      )}
                    </td>
                    <td>{col.type}</td>
                    <td data-numeric="true">{col.distinctCount}</td>
                    <td data-numeric="true">{col.missingCount}</td>
                    <td data-numeric="true">
                      {col.type === "number" && col.min !== undefined && col.max !== undefined
                        ? `${formatCellDisplay(col.min)} – ${formatCellDisplay(col.max)} (μ ${formatCellDisplay(col.mean ?? null)})`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
});

export function createWasmhatchTabularCatalog(
  rpcEngine: A2uiLocalRpcEngine
): Catalog<ReactCatalogComponent> {
  const loadWorkspaceTableImpl: FunctionImplementation = {
    ...LoadWorkspaceTableFnApi,
    execute: async (args, context) => {
      const surface = context.surface as SurfaceModel<ReactCatalogComponent> | undefined;
      return rpcEngine.loadWorkspaceTable(args, surface);
    }
  };

  const exportSafeCsvImpl: FunctionImplementation = {
    ...ExportSafeCsvFnApi,
    execute: async (args, context) => {
      const userActivated = resolveEffectiveUserActivation(undefined, context);
      return rpcEngine.exportSafeCsv(args, { userActivated });
    }
  };

  return new Catalog<ReactCatalogComponent>(
    WASMHATCH_TABULAR_CATALOG_ID,
    "1.0",
    [WasmhatchDataGrid, WasmhatchColumnProfiler],
    [loadWorkspaceTableImpl, exportSafeCsvImpl],
    {
      schemaUri: "https://json-schema.org/draft/2020-12/schema",
      schemaId: WASMHATCH_TABULAR_CATALOG_ID,
      title: "WasmHatch Tabular Catalog",
      description:
        "Interactive CSV/TSV/JSON DataGrid, ColumnProfiler, and formula-safe CSV export.",
      instructions:
        'Use `DataGrid(rows, title=..., pageSize=25, selectionPath=..., exportFileName=...)` to render sortable, filterable tables with automatic formula-injection badges and 1-click safe CSV export. Use `ColumnProfiler(rows, title=...)` for per-column missing/distinct/range summaries. Call `loadWorkspaceTable(path, targetPath="/table")` to load workspace `.csv`/`.tsv`/`.json` files directly into the surface data model.',
      declaredProtocolVersion: "1.0"
    }
  );
}
