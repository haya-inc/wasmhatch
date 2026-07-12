import type { SpreadsheetRows } from "./spreadsheet";

export type GuidedDemoId = "normalization" | "reconciliation";

export interface GuidedDemoDefinition {
  readonly id: GuidedDemoId;
  readonly label: string;
  readonly reportWorkflow: string;
  readonly sourceDescription: string;
  readonly task: string;
  readonly guideDescription: string;
  readonly rows: SpreadsheetRows;
  readonly script: string;
  readonly expectedChangedCells: number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const DEFINITIONS: Record<GuidedDemoId, GuidedDemoDefinition> = {
  normalization: {
    id: "normalization",
    label: "60-second local demo",
    reportWorkflow: "60-second local QuickJS transform and typed cell review",
    sourceDescription: "bundled synthetic pipeline rows",
    task: "Normalize names and regions, convert amounts to numbers, and standardize stages.",
    guideDescription: "No account or API key. Run the preset in QuickJS, inspect the cell diff, then choose whether to apply it.",
    rows: [
      ["Owner", "Region", "Amount", "Stage"],
      ["  aya tanaka", " west ", "12,400", "won"],
      ["KEN ITO  ", "East", "8300", "OPEN"],
      [" mei sato ", " north", "6,250", " Won "]
    ],
    script: `(rows) => rows.map((row, index) => {
  if (index === 0) return row;
  const titleCase = (value) => String(value).trim().toLowerCase()
    .replace(/(^|\\s)\\S/g, (letter) => letter.toUpperCase());
  return [
    titleCase(row[0]),
    String(row[1]).trim().toUpperCase(),
    Number(String(row[2]).replace(/,/g, "")),
    titleCase(row[3])
  ];
})`,
    expectedChangedCells: 12
  },
  reconciliation: {
    id: "reconciliation",
    label: "Invoice reconciliation sample",
    reportWorkflow: "local invoice reconciliation with variance and exception review",
    sourceDescription: "bundled synthetic ERP and payout values",
    task: "Calculate each payout variance and classify every invoice as MATCH, REVIEW, or MISSING without changing source amounts.",
    guideDescription: "No account or API key. Compare synthetic ERP and payout values locally, then review only the derived variance and status cells.",
    rows: [
      ["Invoice", "ERP Amount", "Payout Amount", "Variance", "Status"],
      ["INV-101", 1250, 1250, null, null],
      ["INV-102", 980, 930, null, null],
      ["INV-103", 450, 450, null, null],
      ["INV-104", 1200, null, null, null]
    ],
    script: `(rows) => rows.map((row, index) => {
  if (index === 0) return row;
  const erp = Number(row[1]);
  const payout = row[2] === null ? null : Number(row[2]);
  const variance = payout === null ? null : payout - erp;
  const status = payout === null ? "MISSING" : variance === 0 ? "MATCH" : "REVIEW";
  return [row[0], erp, payout, variance, status];
})`,
    expectedChangedCells: 7
  }
};

Object.values(DEFINITIONS).forEach(deepFreeze);
deepFreeze(DEFINITIONS);

export function guidedDemoDefinition(id: GuidedDemoId) {
  return DEFINITIONS[id];
}

export function resolveGuidedDemo(search: string) {
  const value = new URLSearchParams(search).get("demo");
  const id: GuidedDemoId = value === "reconciliation" ? "reconciliation" : "normalization";
  return deepFreeze({
    id,
    showGuide: value === "local" || value === "normalization" || value === "reconciliation",
    definition: DEFINITIONS[id]
  });
}
