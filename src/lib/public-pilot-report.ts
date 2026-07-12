import type { RunJournal, RunJournalMetrics } from "./run-journal";
import { guidedDemoDefinition, type GuidedDemoId } from "./guided-demo";

export const PUBLIC_PILOT_REPORT_SCHEMA = "wasmhatch.public-pilot-report.v1" as const;

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

export function createGuidedLocalDemoPilotReport(journal: RunJournal, demoId: GuidedDemoId = "normalization") {
  if (!journal || typeof journal !== "object") throw new Error("Pilot run journal is required.");
  const demo = guidedDemoDefinition(demoId);
  const metrics = validateMetrics(journal.metrics);
  if (journal.state !== "committed" || metrics.commits < 1 || metrics.approvals < 1 || metrics.proposalsPrepared < 1) {
    throw new Error("Complete an approved local demo effect before creating its public pilot report.");
  }
  const report = `<!-- ${PUBLIC_PILOT_REPORT_SCHEMA} — inspect before posting; do not add private data. -->
## ${demo.label} pilot

- Workflow: ${demo.reportWorkflow}
- Source: ${demo.sourceDescription}
- Result: committed local effect
- Script runs: ${metrics.scriptRuns}
- Proposals prepared: ${metrics.proposalsPrepared}
- Approvals: ${metrics.approvals}
- Rejections: ${metrics.rejections}
- Conflicts: ${metrics.conflicts}
- Uncertain outcomes: ${metrics.uncertainOutcomes}
- Time to first proposal: ${formatDuration(metrics.timeToFirstProposalMs)}
- Time to first commit: ${formatDuration(metrics.timeToFirstCommitMs)}
- Account, API key, OAuth, upload, or server used: no
- Source contents, task text, resource identifiers, and run ID included: no

### Human assessment

- Was the before/after review clear enough to approve safely?
- What was the first confusing or slow step?
- What real CSV/XLSX or Google Sheets workflow would you try next?
- Would you use this review model again? yes / maybe / no
`;
  if (new TextEncoder().encode(report).byteLength > 8 * 1024) throw new Error("Public pilot report exceeds 8 KB.");
  return report;
}
