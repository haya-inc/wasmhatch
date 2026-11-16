import "./dom-polyfill-guard";
import { useEffect, useId, useMemo, useState } from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import {
  Catalog,
  DynamicNumberSchema,
  DynamicValueSchema,
  spec,
  type ComponentApi
} from "@a2ui/web_core/v1_0";
// A2UI uses the security-patched v3 compatibility API from Zod 4.
import { z } from "zod/v3";

/** Canonical A2UI v1.0 VegaChart catalog identifier. */
export const VEGACHART_V1_CATALOG_ID =
  "https://a2ui.org/specification/v1_0/catalogs/vegachart/catalog.json";

const DEFAULT_CHART_HEIGHT = 280;
const SVG_VIEWBOX_WIDTH = 640;
const SERIES_PALETTE_COUNT = 8;

export const VegaChartV1Api = {
  name: "VegaChart",
  schema: spec(
    z
      .object({
        spec: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|The Vega-Lite spec to render as a JSON object."
        ),
        height: DynamicNumberSchema.describe(
          "REF:#/$defs/DynamicNumber|Optional height of the chart in pixels. Defaults to 280."
        ).optional()
      })
      .describe("Displays a Vega-Lite chart as an accessible reactive SVG visualization.")
      .strict(),
    { mixins: [], required: ["spec"] }
  )
} satisfies ComponentApi;

type ChartMarkKind = "bar" | "line" | "area" | "point" | "arc";
type AggregateOp = "sum" | "mean" | "count" | "min" | "max" | null;

interface NormalizedChartDatum {
  xLabel: string;
  xNumeric: number | null;
  yValue: number;
  series: string;
  raw: Record<string, unknown>;
}

interface NormalizedVegaSpec {
  title: string;
  description: string;
  mark: ChartMarkKind;
  donutInnerRatio: number;
  xField: string;
  xTitle: string;
  yField: string;
  yTitle: string;
  colorField: string | null;
  colorTitle: string;
  seriesNames: string[];
  categories: string[];
  points: NormalizedChartDatum[];
  dataPath: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMarkKind(rawMark: unknown): { mark: ChartMarkKind; donutInnerRatio: number } {
  if (typeof rawMark === "string") {
    const lower = rawMark.trim().toLowerCase();
    if (lower === "line") return { mark: "line", donutInnerRatio: 0 };
    if (lower === "area") return { mark: "area", donutInnerRatio: 0 };
    if (lower === "point" || lower === "circle" || lower === "square" || lower === "scatter") {
      return { mark: "point", donutInnerRatio: 0 };
    }
    if (lower === "arc" || lower === "pie") return { mark: "arc", donutInnerRatio: 0 };
    if (lower === "donut") return { mark: "arc", donutInnerRatio: 0.52 };
    return { mark: "bar", donutInnerRatio: 0 };
  }
  if (isPlainRecord(rawMark)) {
    const base = parseMarkKind(rawMark.type ?? "bar");
    const innerRadius = typeof rawMark.innerRadius === "number" ? rawMark.innerRadius : 0;
    if (base.mark === "arc" && innerRadius > 0) {
      return { mark: "arc", donutInnerRatio: Math.min(0.75, Math.max(0.28, innerRadius / 110)) };
    }
    return base;
  }
  return { mark: "bar", donutInnerRatio: 0 };
}

function parseAggregate(rawAgg: unknown): AggregateOp {
  if (typeof rawAgg !== "string") return null;
  const lower = rawAgg.trim().toLowerCase();
  if (lower === "sum") return "sum";
  if (lower === "mean" || lower === "average" || lower === "avg") return "mean";
  if (lower === "count") return "count";
  if (lower === "min") return "min";
  if (lower === "max") return "max";
  return null;
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const cleaned = raw.replace(/[,$\s%]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractValuesArray(rawValues: unknown): Record<string, unknown>[] {
  if (Array.isArray(rawValues)) {
    return rawValues.map((item, idx) =>
      isPlainRecord(item) ? item : { index: idx + 1, value: item }
    );
  }
  if (isPlainRecord(rawValues)) {
    if (Array.isArray(rawValues.rows)) return extractValuesArray(rawValues.rows);
    if (Array.isArray(rawValues.values)) return extractValuesArray(rawValues.values);
  }
  return [];
}

export function normalizeVegaLiteSpec(
  rawInput: unknown,
  externalData?: unknown
): NormalizedVegaSpec | null {
  let specObj: Record<string, unknown> | null = null;
  if (typeof rawInput === "string") {
    try {
      const parsed = JSON.parse(rawInput);
      if (isPlainRecord(parsed)) specObj = parsed;
    } catch {
      return null;
    }
  } else if (isPlainRecord(rawInput)) {
    specObj = rawInput;
  }
  if (!specObj) return null;

  const firstLayer =
    Array.isArray(specObj.layer) && isPlainRecord(specObj.layer[0]) ? specObj.layer[0] : null;
  const { mark, donutInnerRatio } = parseMarkKind(specObj.mark ?? firstLayer?.mark ?? "bar");

  const title =
    typeof specObj.title === "string"
      ? specObj.title
      : isPlainRecord(specObj.title) && typeof specObj.title.text === "string"
        ? specObj.title.text
        : "";
  const description = typeof specObj.description === "string" ? specObj.description : "";

  const dataNode = isPlainRecord(specObj.data) ? specObj.data : {};
  const dataPath =
    typeof dataNode.path === "string"
      ? dataNode.path
      : typeof dataNode["@path"] === "string"
        ? (dataNode["@path"] as string)
        : null;

  const rawValues = externalData !== undefined ? externalData : dataNode.values;
  const records = extractValuesArray(rawValues);

  const encoding = {
    ...(firstLayer && isPlainRecord(firstLayer.encoding) ? firstLayer.encoding : {}),
    ...(isPlainRecord(specObj.encoding) ? specObj.encoding : {})
  };

  const xEnc = isPlainRecord(encoding.x) ? encoding.x : {};
  const yEnc = isPlainRecord(encoding.y) ? encoding.y : {};
  const thetaEnc = isPlainRecord(encoding.theta) ? encoding.theta : {};
  const colorEnc = isPlainRecord(encoding.color) ? encoding.color : {};

  const sampleKeys = records[0] ? Object.keys(records[0]) : [];
  const defaultCategoryKey =
    sampleKeys.find((k) => typeof records[0]?.[k] === "string") ?? sampleKeys[0] ?? "x";
  const defaultNumericKey =
    sampleKeys.find((k) => toFiniteNumber(records[0]?.[k]) !== null && k !== defaultCategoryKey) ??
    sampleKeys[1] ??
    sampleKeys[0] ??
    "y";

  const xField =
    mark === "arc"
      ? (typeof colorEnc.field === "string" && colorEnc.field) ||
        (typeof xEnc.field === "string" && xEnc.field) ||
        defaultCategoryKey
      : (typeof xEnc.field === "string" && xEnc.field) || defaultCategoryKey;

  const yAggregate = parseAggregate(mark === "arc" ? thetaEnc.aggregate ?? yEnc.aggregate : yEnc.aggregate);
  const yField =
    mark === "arc"
      ? (typeof thetaEnc.field === "string" && thetaEnc.field) ||
        (typeof yEnc.field === "string" && yEnc.field) ||
        defaultNumericKey
      : (typeof yEnc.field === "string" && yEnc.field) || defaultNumericKey;

  const colorField =
    mark === "arc"
      ? null
      : typeof colorEnc.field === "string" && colorEnc.field.trim()
        ? colorEnc.field.trim()
        : null;

  const xTitle =
    (typeof xEnc.title === "string" && xEnc.title) ||
    (mark === "arc" && typeof colorEnc.title === "string" ? colorEnc.title : "") ||
    xField;
  const yTitle =
    (typeof yEnc.title === "string" && yEnc.title) ||
    (mark === "arc" && typeof thetaEnc.title === "string" ? thetaEnc.title : "") ||
    (yAggregate === "count" ? "Count" : yField);
  const colorTitle =
    (typeof colorEnc.title === "string" && colorEnc.title) || colorField || "";

  const categories: string[] = [];
  const categorySet = new Set<string>();
  const seriesNames: string[] = [];
  const seriesSet = new Set<string>();

  interface Bucket {
    xLabel: string;
    xNumeric: number | null;
    series: string;
    values: number[];
    raw: Record<string, unknown>;
  }
  const buckets = new Map<string, Bucket>();
  const rawPoints: NormalizedChartDatum[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const rawX = rec[xField];
    const xLabel = rawX === undefined || rawX === null ? String(i + 1) : String(rawX);
    const xNumeric = toFiniteNumber(rawX);
    const rawY = yAggregate === "count" ? 1 : toFiniteNumber(rec[yField]);
    if (rawY === null) continue;

    const series = colorField
      ? String(rec[colorField] ?? "Default")
      : yTitle || "Series";

    if (!categorySet.has(xLabel)) {
      categorySet.add(xLabel);
      categories.push(xLabel);
    }
    if (!seriesSet.has(series)) {
      seriesSet.add(series);
      seriesNames.push(series);
    }

    if (yAggregate) {
      const bKey = `${series}::${xLabel}`;
      const existing = buckets.get(bKey);
      if (existing) {
        existing.values.push(rawY);
      } else {
        buckets.set(bKey, { xLabel, xNumeric, series, values: [rawY], raw: rec });
      }
    } else {
      rawPoints.push({ xLabel, xNumeric, yValue: rawY, series, raw: rec });
    }
  }

  const points: NormalizedChartDatum[] = yAggregate
    ? [...buckets.values()].map((b) => {
        let yValue = 0;
        if (yAggregate === "count" || yAggregate === "sum") {
          yValue = b.values.reduce((acc, v) => acc + v, 0);
        } else if (yAggregate === "mean") {
          yValue = b.values.reduce((acc, v) => acc + v, 0) / b.values.length;
        } else if (yAggregate === "min") {
          yValue = Math.min(...b.values);
        } else if (yAggregate === "max") {
          yValue = Math.max(...b.values);
        }
        return {
          xLabel: b.xLabel,
          xNumeric: b.xNumeric,
          yValue: Number(yValue.toFixed(6)),
          series: b.series,
          raw: b.raw
        };
      })
    : rawPoints;

  if (seriesNames.length === 0) {
    seriesNames.push(yTitle || "Series");
  }

  return {
    title,
    description,
    mark,
    donutInnerRatio,
    xField,
    xTitle,
    yField,
    yTitle,
    colorField,
    colorTitle,
    seriesNames,
    categories,
    points,
    dataPath
  };
}

function niceScaleDomain(minVal: number, maxVal: number, includeZero: boolean): {
  min: number;
  max: number;
  ticks: number[];
} {
  let lo = includeZero ? Math.min(0, minVal) : minVal;
  let hi = includeZero ? Math.max(0, maxVal) : maxVal;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { min: 0, max: 10, ticks: [0, 2.5, 5, 7.5, 10] };
  }
  if (lo === hi) {
    if (lo === 0) {
      hi = 10;
    } else {
      const pad = Math.abs(lo) * 0.2 || 1;
      lo = includeZero && lo > 0 ? 0 : lo - pad;
      hi += pad;
    }
  }
  const span = hi - lo;
  const roughStep = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(roughStep) || 1)));
  const norm = roughStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.001 && ticks.length < 8; v += step) {
    ticks.push(Number(v.toFixed(8)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function formatCompactNumber(val: number): string {
  if (!Number.isFinite(val)) return "0";
  const abs = Math.abs(val);
  if (abs >= 1_000_000) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(val);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: abs < 10 ? 2 : 1 }).format(val);
}

function polarToCartesian(cx: number, cy: number, radius: number, angleRad: number): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad)
  };
}

function describeArcSlice(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const clampedSpan = Math.min(Math.PI * 2 - 0.0005, Math.max(0.001, endAngle - startAngle));
  const actualEnd = startAngle + clampedSpan;
  const largeArc = clampedSpan > Math.PI ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, actualEnd);

  if (innerRadius <= 0.5) {
    return [
      `M ${cx.toFixed(2)} ${cy.toFixed(2)}`,
      `L ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
      `A ${outerRadius.toFixed(2)} ${outerRadius.toFixed(2)} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
      "Z"
    ].join(" ");
  }

  const innerEnd = polarToCartesian(cx, cy, innerRadius, actualEnd);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerRadius.toFixed(2)} ${outerRadius.toFixed(2)} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerRadius.toFixed(2)} ${innerRadius.toFixed(2)} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    "Z"
  ].join(" ");
}

function truncateAxisLabel(label: string, maxLen = 14): string {
  return label.length > maxLen ? `${label.slice(0, maxLen - 1)}…` : label;
}

const WasmhatchVegaChart = createComponentImplementation(VegaChartV1Api, ({ props, context }) => {
  const titleId = useId();
  const descId = useId();
  const [activePointIdx, setActivePointIdx] = useState<number | null>(null);
  const [boundPathData, setBoundPathData] = useState<unknown>(undefined);

  const initialParsed = useMemo(() => normalizeVegaLiteSpec(props.spec), [props.spec]);
  const dataPath = initialParsed?.dataPath ?? null;

  useEffect(() => {
    if (!dataPath) {
      setBoundPathData(undefined);
      return;
    }
    const sub = context.dataContext.subscribeDynamicValue({ "@path": dataPath }, (nextVal) => {
      setBoundPathData(nextVal);
    });
    setBoundPathData(sub.value);
    return () => sub.unsubscribe();
  }, [context.dataContext, dataPath]);

  const parsed = useMemo(
    () => normalizeVegaLiteSpec(props.spec, dataPath ? boundPathData : undefined),
    [boundPathData, dataPath, props.spec]
  );

  const svgHeight = useMemo(() => {
    const rawH = typeof props.height === "number" && Number.isFinite(props.height)
      ? props.height
      : DEFAULT_CHART_HEIGHT;
    return Math.max(180, Math.min(540, Math.round(rawH)));
  }, [props.height]);

  if (!parsed) {
    return (
      <div className="a2ui-chart-card a2ui-chart-empty" role="status">
        {t`Chart specification could not be parsed.`}
      </div>
    );
  }

  const { points, categories, seriesNames, mark, donutInnerRatio } = parsed;
  const chartTitle = parsed.title || t`${parsed.yTitle} by ${parsed.xTitle}`;
  const showLegend = mark === "arc" ? categories.length > 1 : seriesNames.length > 1;
  const activeDatum = activePointIdx !== null ? points[activePointIdx] ?? null : null;

  if (points.length === 0) {
    return (
      <figure className="a2ui-chart-card" aria-labelledby={titleId}>
        <figcaption id={titleId} className="a2ui-chart-header">
          <span className="a2ui-chart-title">{chartTitle}</span>
        </figcaption>
        <p className="a2ui-chart-empty-note">{t`No data rows to plot yet.`}</p>
      </figure>
    );
  }

  const padLeft = 58;
  const padRight = 22;
  const padTop = 18;
  const padBottom = 42;
  const plotW = SVG_VIEWBOX_WIDTH - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;

  const yValues = points.map((p) => p.yValue);
  const yScale = niceScaleDomain(
    Math.min(...yValues),
    Math.max(...yValues),
    mark === "bar" || mark === "area"
  );
  const ySpan = yScale.max - yScale.min || 1;
  const mapY = (val: number) => padTop + plotH - ((val - yScale.min) / ySpan) * plotH;
  const zeroY = mapY(Math.max(yScale.min, Math.min(yScale.max, 0)));

  const allNumericX =
    mark === "point" && points.every((p) => p.xNumeric !== null);
  const xScale = allNumericX
    ? niceScaleDomain(
        Math.min(...points.map((p) => p.xNumeric ?? 0)),
        Math.max(...points.map((p) => p.xNumeric ?? 0)),
        false
      )
    : null;

  const categoryIndex = new Map(categories.map((c, idx) => [c, idx]));
  const seriesIndex = new Map(seriesNames.map((s, idx) => [s, idx]));

  const xStep = categories.length > 0 ? plotW / categories.length : plotW;
  const maxXTicks = 8;
  const xLabelStride = Math.max(1, Math.ceil(categories.length / maxXTicks));

  return (
    <figure className="a2ui-chart-card" aria-labelledby={titleId}>
      <figcaption className="a2ui-chart-header">
        <div className="a2ui-chart-heading-group">
          <span id={titleId} className="a2ui-chart-title">
            {chartTitle}
          </span>
          {parsed.description && (
            <span id={descId} className="a2ui-chart-subtitle">
              {parsed.description}
            </span>
          )}
        </div>
        <div className="a2ui-chart-readout" aria-live="polite">
          {activeDatum ? (
            <span>
              <strong>{activeDatum.xLabel}</strong>
              {seriesNames.length > 1 ? ` · ${activeDatum.series}` : ""}:{" "}
              <span className="a2ui-chart-readout-val">{formatCompactNumber(activeDatum.yValue)}</span>
            </span>
          ) : (
            <span className="a2ui-chart-readout-hint">{t`Hover or focus a mark to inspect`}</span>
          )}
        </div>
      </figcaption>

      {showLegend && (
        <ul className="a2ui-chart-legend" aria-label={parsed.colorTitle || t`Series`}>
          {(mark === "arc" ? categories.slice(0, 12) : seriesNames).map((label, idx) => (
            <li key={label} className="a2ui-chart-legend-item">
              <span
                className="a2ui-chart-swatch"
                data-series={String(idx % SERIES_PALETTE_COUNT)}
                aria-hidden="true"
              />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="a2ui-chart-svg-wrap">
        <svg
          className="a2ui-chart-svg"
          viewBox={`0 0 ${SVG_VIEWBOX_WIDTH} ${svgHeight}`}
          role="img"
          aria-labelledby={parsed.description ? `${titleId} ${descId}` : titleId}
        >
          {mark === "arc" ? (
            (() => {
              const positivePoints = points.map((p, idx) => ({
                ...p,
                idx,
                weight: Math.max(0, p.yValue)
              }));
              const total = positivePoints.reduce((acc, p) => acc + p.weight, 0) || 1;
              const cx = SVG_VIEWBOX_WIDTH / 2;
              const cy = svgHeight / 2;
              const outerR = Math.max(48, Math.min(plotW, svgHeight - 28) / 2);
              const innerR = outerR * donutInnerRatio;
              let cursor = -Math.PI / 2;

              return (
                <g>
                  {positivePoints.map((slice, sIdx) => {
                    const angle = (slice.weight / total) * Math.PI * 2;
                    const start = cursor;
                    const end = cursor + angle;
                    cursor = end;
                    const d = describeArcSlice(cx, cy, outerR, innerR, start, end);
                    const pct = Math.round((slice.weight / total) * 100);
                    return (
                      <path
                        key={`${slice.xLabel}-${slice.idx}`}
                        d={d}
                        className="a2ui-chart-arc"
                        data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                        data-active={activePointIdx === slice.idx ? "true" : undefined}
                        tabIndex={0}
                        aria-label={`${slice.xLabel}: ${formatCompactNumber(slice.yValue)} (${pct}%)`}
                        onMouseEnter={() => setActivePointIdx(slice.idx)}
                        onMouseLeave={() => setActivePointIdx(null)}
                        onFocus={() => setActivePointIdx(slice.idx)}
                        onBlur={() => setActivePointIdx(null)}
                      />
                    );
                  })}
                  {donutInnerRatio > 0 && (
                    <text x={cx} y={cy + 5} textAnchor="middle" className="a2ui-chart-donut-total">
                      {formatCompactNumber(total)}
                    </text>
                  )}
                </g>
              );
            })()
          ) : (
            <g>
              {yScale.ticks.map((tick) => {
                const y = mapY(tick);
                return (
                  <g key={tick}>
                    <line
                      x1={padLeft}
                      x2={SVG_VIEWBOX_WIDTH - padRight}
                      y1={y}
                      y2={y}
                      className="a2ui-chart-gridline"
                    />
                    <text
                      x={padLeft - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="a2ui-chart-axis-text"
                    >
                      {formatCompactNumber(tick)}
                    </text>
                  </g>
                );
              })}

              <line
                x1={padLeft}
                x2={SVG_VIEWBOX_WIDTH - padRight}
                y1={zeroY}
                y2={zeroY}
                className="a2ui-chart-baseline"
              />

              {xScale
                ? xScale.ticks.map((tick) => {
                    const span = xScale.max - xScale.min || 1;
                    const x = padLeft + ((tick - xScale.min) / span) * plotW;
                    return (
                      <text
                        key={tick}
                        x={x}
                        y={svgHeight - 14}
                        textAnchor="middle"
                        className="a2ui-chart-axis-text"
                      >
                        {formatCompactNumber(tick)}
                      </text>
                    );
                  })
                : categories.map((cat, idx) => {
                    if (idx % xLabelStride !== 0) return null;
                    const x =
                      mark === "bar"
                        ? padLeft + idx * xStep + xStep / 2
                        : categories.length === 1
                          ? padLeft + plotW / 2
                          : padLeft + (idx / (categories.length - 1)) * plotW;
                    return (
                      <text
                        key={cat}
                        x={x}
                        y={svgHeight - 14}
                        textAnchor="middle"
                        className="a2ui-chart-axis-text"
                      >
                        {truncateAxisLabel(cat)}
                      </text>
                    );
                  })}

              {mark === "bar" &&
                points.map((pt, idx) => {
                  const catIdx = categoryIndex.get(pt.xLabel) ?? 0;
                  const sIdx = seriesIndex.get(pt.series) ?? 0;
                  const groupPad = Math.min(14, xStep * 0.22);
                  const usableBand = Math.max(6, xStep - groupPad);
                  const subBarW = Math.max(4, Math.min(44, usableBand / seriesNames.length - 2));
                  const groupStart =
                    padLeft +
                    catIdx * xStep +
                    (xStep - subBarW * seriesNames.length - (seriesNames.length - 1) * 2) / 2;
                  const barX = groupStart + sIdx * (subBarW + 2);
                  const valY = mapY(pt.yValue);
                  const barTop = Math.min(valY, zeroY);
                  const barH = Math.max(2, Math.abs(zeroY - valY));
                  return (
                    <rect
                      key={`${pt.series}-${pt.xLabel}-${idx}`}
                      x={barX}
                      y={barTop}
                      width={subBarW}
                      height={barH}
                      rx={3}
                      className="a2ui-chart-bar"
                      data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                      data-active={activePointIdx === idx ? "true" : undefined}
                      tabIndex={0}
                      aria-label={`${pt.xLabel}${seriesNames.length > 1 ? ` (${pt.series})` : ""}: ${formatCompactNumber(pt.yValue)}`}
                      onMouseEnter={() => setActivePointIdx(idx)}
                      onMouseLeave={() => setActivePointIdx(null)}
                      onFocus={() => setActivePointIdx(idx)}
                      onBlur={() => setActivePointIdx(null)}
                    />
                  );
                })}

              {(mark === "line" || mark === "area") &&
                seriesNames.map((sName, sIdx) => {
                  const seriesPts = points
                    .map((pt, idx) => ({ pt, idx }))
                    .filter((entry) => entry.pt.series === sName);
                  if (seriesPts.length === 0) return null;
                  const coords = seriesPts.map(({ pt, idx }) => {
                    const catIdx = categoryIndex.get(pt.xLabel) ?? 0;
                    const x =
                      categories.length <= 1
                        ? padLeft + plotW / 2
                        : padLeft + (catIdx / (categories.length - 1)) * plotW;
                    const y = mapY(pt.yValue);
                    return { x, y, pt, idx };
                  });
                  const linePath = coords
                    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
                    .join(" ");
                  const areaPath =
                    mark === "area" && coords.length > 0
                      ? `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${zeroY.toFixed(2)} L ${coords[0].x.toFixed(2)} ${zeroY.toFixed(2)} Z`
                      : null;

                  return (
                    <g key={sName}>
                      {areaPath && (
                        <path
                          d={areaPath}
                          className="a2ui-chart-area"
                          data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                        />
                      )}
                      <path
                        d={linePath}
                        fill="none"
                        className="a2ui-chart-line"
                        data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                      />
                      {coords.map((c) => (
                        <circle
                          key={`${sName}-${c.idx}`}
                          cx={c.x}
                          cy={c.y}
                          r={activePointIdx === c.idx ? 5.5 : 4}
                          className="a2ui-chart-dot"
                          data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                          data-active={activePointIdx === c.idx ? "true" : undefined}
                          tabIndex={0}
                          aria-label={`${c.pt.xLabel}${seriesNames.length > 1 ? ` (${c.pt.series})` : ""}: ${formatCompactNumber(c.pt.yValue)}`}
                          onMouseEnter={() => setActivePointIdx(c.idx)}
                          onMouseLeave={() => setActivePointIdx(null)}
                          onFocus={() => setActivePointIdx(c.idx)}
                          onBlur={() => setActivePointIdx(null)}
                        />
                      ))}
                    </g>
                  );
                })}

              {mark === "point" &&
                points.map((pt, idx) => {
                  const sIdx = seriesIndex.get(pt.series) ?? 0;
                  const x = xScale
                    ? padLeft + (((pt.xNumeric ?? 0) - xScale.min) / (xScale.max - xScale.min || 1)) * plotW
                    : categories.length <= 1
                      ? padLeft + plotW / 2
                      : padLeft + ((categoryIndex.get(pt.xLabel) ?? 0) / (categories.length - 1)) * plotW;
                  const y = mapY(pt.yValue);
                  return (
                    <circle
                      key={`${pt.series}-${idx}`}
                      cx={x}
                      cy={y}
                      r={activePointIdx === idx ? 6.5 : 5}
                      className="a2ui-chart-dot"
                      data-series={String(sIdx % SERIES_PALETTE_COUNT)}
                      data-active={activePointIdx === idx ? "true" : undefined}
                      tabIndex={0}
                      aria-label={`${pt.xLabel}${seriesNames.length > 1 ? ` (${pt.series})` : ""}: ${formatCompactNumber(pt.yValue)}`}
                      onMouseEnter={() => setActivePointIdx(idx)}
                      onMouseLeave={() => setActivePointIdx(null)}
                      onFocus={() => setActivePointIdx(idx)}
                      onBlur={() => setActivePointIdx(null)}
                    />
                  );
                })}
            </g>
          )}
        </svg>
      </div>

      <details className="a2ui-disclosure a2ui-chart-summary-details">
        <summary className="a2ui-disclosure-summary">
          {t`Data summary (${points.length} points)`}
        </summary>
        <div className="a2ui-disclosure-body">
          <table className="a2ui-mini-table">
            <thead>
              <tr>
                <th scope="col">{parsed.xTitle}</th>
                {seriesNames.length > 1 && <th scope="col">{parsed.colorTitle || t`Series`}</th>}
                <th scope="col">{parsed.yTitle}</th>
              </tr>
            </thead>
            <tbody>
              {points.slice(0, 25).map((pt, idx) => (
                <tr key={`${pt.series}-${pt.xLabel}-${idx}`}>
                  <td>{pt.xLabel}</td>
                  {seriesNames.length > 1 && <td>{pt.series}</td>}
                  <td data-numeric="true">{formatCompactNumber(pt.yValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
});

export function createWasmhatchVegaChartCatalog(): Catalog<ReactCatalogComponent> {
  return new Catalog<ReactCatalogComponent>(
    VEGACHART_V1_CATALOG_ID,
    "1.0",
    [WasmhatchVegaChart],
    [],
    {
      schemaUri: "https://json-schema.org/draft/2020-12/schema",
      schemaId: VEGACHART_V1_CATALOG_ID,
      title: "A2UI VegaChart Catalog",
      description:
        "CSP-pure reactive SVG Vega-Lite chart catalog supporting bar, line, area, point/scatter, and arc/donut visualizations.",
      instructions:
        'Use `VegaChart(spec, height=280)` to visualize tabular or simulated metrics. Pass a Vega-Lite object in `spec` with `mark` ("bar" | "line" | "area" | "point" | "arc" | "donut"), `data: { values: [...] }` (or bind `spec` / `data.values` to a `$path` such as `$/sim/rows`), and `encoding: { x: { field: "..." }, y: { field: "...", aggregate: "sum" }, color: { field: "..." } }`.',
      declaredProtocolVersion: "1.0"
    }
  );
}
