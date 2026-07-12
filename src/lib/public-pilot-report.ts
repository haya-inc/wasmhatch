import type { RunJournal, RunJournalMetrics } from "./run-journal";
import { guidedDemoDefinition, type GuidedDemoId } from "./guided-demo";

export const PUBLIC_PILOT_REPORT_SCHEMA = "wasmhatch.public-pilot-report.v1" as const;

export type PublicPilotWorkflowId = GuidedDemoId | "brief-to-report" | "first-run-csv" | "local-csv" | "local-xlsx" | "google-sheets";

interface PublicPilotWorkflowMetadata {
  readonly label: string;
  readonly workflow: string;
  readonly source: string;
  readonly externalAuthority: string;
  readonly nextQuestion: string;
}

const PUBLIC_WORKFLOWS: Readonly<Record<PublicPilotWorkflowId, PublicPilotWorkflowMetadata>> = Object.freeze({
  normalization: Object.freeze({
    label: guidedDemoDefinition("normalization").label,
    workflow: guidedDemoDefinition("normalization").reportWorkflow,
    source: guidedDemoDefinition("normalization").sourceDescription,
    externalAuthority: "no",
    nextQuestion: "What real CSV/XLSX or Google Sheets workflow would you try next?"
  }),
  reconciliation: Object.freeze({
    label: guidedDemoDefinition("reconciliation").label,
    workflow: guidedDemoDefinition("reconciliation").reportWorkflow,
    source: guidedDemoDefinition("reconciliation").sourceDescription,
    externalAuthority: "no",
    nextQuestion: "What real CSV/XLSX or Google Sheets workflow would you try next?"
  }),
  "brief-to-report": Object.freeze({
    label: "Weekly brief to report sample",
    workflow: "bundled Markdown brief transformed into one reviewed Markdown decision report",
    source: "bundled synthetic weekly operations brief",
    externalAuthority: "no",
    nextQuestion: "What real brief, notes, or document workflow would you try next?"
  }),
  "first-run-csv": Object.freeze({
    label: "First-run CSV sample",
    workflow: "bundled CSV import Worker, local QuickJS transform, and typed cell review",
    source: "bundled synthetic CSV parsed in a browser Worker",
    externalAuthority: "no",
    nextQuestion: "What real CSV/XLSX or Google Sheets workflow would you try next?"
  }),
  "local-csv": Object.freeze({
    label: "Local CSV workflow",
    workflow: "local CSV transformation with typed cell or file-effect review",
    source: "user-selected CSV parsed in a browser Worker",
    externalAuthority: "no",
    nextQuestion: "What capability would make this workflow repeatable?"
  }),
  "local-xlsx": Object.freeze({
    label: "Local XLSX workflow",
    workflow: "local XLSX transformation with typed cell or file-effect review",
    source: "user-selected XLSX normalized in a browser Worker",
    externalAuthority: "no",
    nextQuestion: "What capability would make this workflow repeatable?"
  }),
  "google-sheets": Object.freeze({
    label: "Google Sheets workflow",
    workflow: "foreground Google Sheets operation with typed cell or local file-effect review",
    source: "one foreground-loaded Google Sheets range",
    externalAuthority: "foreground Google account and OAuth",
    nextQuestion: "What capability would make this workflow repeatable?"
  })
});

function requireMetric(value: number | null, label: string) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 24 * 60 * 60 * 1_000) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "not recorded";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${(seconds / 60).toFixed(1)} min`;
}

function validateMetrics(metrics: RunJournalMetrics) {
  const counts = [
    metrics.modelEvents,
    metrics.toolCalls,
    metrics.scriptRuns,
    metrics.proposalsPrepared,
    metrics.approvals,
    metrics.rejections,
    metrics.commits,
    metrics.conflicts,
    metrics.uncertainOutcomes,
    metrics.failures
  ];
  if (counts.some((value) => !Number.isInteger(value) || value < 0 || value > 10_000)) {
    throw new Error("Pilot report metrics are invalid.");
  }
  return {
    ...metrics,
    elapsedMs: requireMetric(metrics.elapsedMs, "Pilot elapsed time")!,
    timeToFirstProposalMs: requireMetric(metrics.timeToFirstProposalMs, "Pilot proposal time"),
    timeToFirstCommitMs: requireMetric(metrics.timeToFirstCommitMs, "Pilot commit time")
  };
}

export function createPublicPilotReport(journal: RunJournal, workflowId: PublicPilotWorkflowId) {
  if (!journal || typeof journal !== "object") throw new Error("Pilot run journal is required.");
  const workflow = PUBLIC_WORKFLOWS[workflowId];
  if (!workflow) throw new Error("Public pilot workflow is unsupported.");
  const metrics = validateMetrics(journal.metrics);
  const terminal = [...journal.events].reverse().find((event) =>
    ["committed", "rejected", "conflict", "uncertain", "failed", "denied"].includes(event.outcome)
  );
  const committed = terminal?.outcome === "committed" && metrics.commits >= 1 && metrics.approvals >= 1;
  const rejected = terminal?.outcome === "rejected" && metrics.rejections >= 1;
  if (metrics.proposalsPrepared < 1 || (!committed && !rejected)) {
    throw new Error("Complete an approved or rejected effect proposal before creating its public pilot report.");
  }
  const report = `<!-- ${PUBLIC_PILOT_REPORT_SCHEMA} — inspect before posting; do not add private data. -->
## ${workflow.label} pilot

- Workflow: ${workflow.workflow}
- Source: ${workflow.source}
- Result: ${committed ? "committed local effect" : "rejected proposal; no effect from that proposal"}
- Script runs: ${metrics.scriptRuns}
- Proposals prepared: ${metrics.proposalsPrepared}
- Approvals: ${metrics.approvals}
- Rejections: ${metrics.rejections}
- Conflicts: ${metrics.conflicts}
- Uncertain outcomes: ${metrics.uncertainOutcomes}
- Time to first proposal: ${formatDuration(metrics.timeToFirstProposalMs)}
- Time to first commit: ${formatDuration(metrics.timeToFirstCommitMs)}
- External account or OAuth used: ${workflow.externalAuthority}
- Model requests recorded: ${metrics.modelEvents > 0 ? "yes" : "no"}
- WasmHatch server or source upload used: no
- Source contents, task text, resource identifiers, and run ID included: no

### Human assessment

- Was the before/after review clear enough to approve safely?
- What was the first confusing or slow step?
- ${workflow.nextQuestion}
- Would you use this review model again? yes / maybe / no
`;
  if (new TextEncoder().encode(report).byteLength > 8 * 1024) throw new Error("Public pilot report exceeds 8 KB.");
  return report;
}

export function createGuidedLocalDemoPilotReport(journal: RunJournal, demoId: GuidedDemoId = "normalization") {
  return createPublicPilotReport(journal, demoId);
}
