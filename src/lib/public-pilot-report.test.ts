import { describe, expect, it } from "vitest";
import { appendRunJournalEvent, createRunJournal } from "./run-journal";
import { createGuidedLocalDemoPilotReport } from "./public-pilot-report";

function committedJournal() {
  let journal = createRunJournal({
    runId: `run_journal_${"a".repeat(32)}`,
    startedAt: "2026-07-12T00:00:00.000Z"
  });
  journal = appendRunJournalEvent(journal, {
    category: "script",
    outcome: "completed",
    summary: "Sandbox script completed",
    occurredAt: "2026-07-12T00:00:01.000Z"
  });
  journal = appendRunJournalEvent(journal, {
    category: "proposal",
    outcome: "prepared",
    summary: "Typed mutation proposal prepared",
    occurredAt: "2026-07-12T00:00:02.500Z"
  });
  journal = appendRunJournalEvent(journal, {
    category: "approval",
    outcome: "approved",
    summary: "Spreadsheet proposal approved",
    occurredAt: "2026-07-12T00:00:04.000Z"
  });
  return appendRunJournalEvent(journal, {
    category: "effect",
    outcome: "committed",
    summary: "Local effect committed",
    occurredAt: "2026-07-12T00:00:05.000Z"
  });
}

function rejectedJournal() {
  let journal = createRunJournal({
    runId: `run_journal_${"c".repeat(32)}`,
    startedAt: "2026-07-12T00:00:00.000Z"
  });
  journal = appendRunJournalEvent(journal, {
    category: "script",
    outcome: "completed",
    summary: "Sandbox script completed",
    occurredAt: "2026-07-12T00:00:01.000Z"
  });
  journal = appendRunJournalEvent(journal, {
    category: "proposal",
    outcome: "prepared",
    summary: "Typed mutation proposal prepared",
    occurredAt: "2026-07-12T00:00:02.000Z"
  });
  return appendRunJournalEvent(journal, {
    category: "approval",
    outcome: "rejected",
    summary: "Write proposal rejected",
    occurredAt: "2026-07-12T00:00:03.000Z"
  });
}

describe("public pilot reports", () => {
  it("creates a bounded source-free Markdown summary from aggregate metrics", () => {
    const report = createGuidedLocalDemoPilotReport(committedJournal());
    expect(report).toContain("wasmhatch.public-pilot-report.v1");
    expect(report).toContain("Time to first proposal: 2.5 s");
    expect(report).toContain("Time to first commit: 5.0 s");
    expect(report).toContain("Account, API key, OAuth, upload, or server used: no");
    expect(report).not.toContain("run_journal_");
    expect(report).not.toContain("aya tanaka");
    expect(new TextEncoder().encode(report).byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  it("requires a committed, approved proposal", () => {
    const journal = createRunJournal({
      runId: `run_journal_${"b".repeat(32)}`,
      startedAt: "2026-07-12T00:00:00.000Z"
    });
    expect(() => createGuidedLocalDemoPilotReport(journal)).toThrow("Complete an approved or rejected local demo proposal");
  });

  it("reports a safe rejection as useful negative pilot evidence", () => {
    const report = createGuidedLocalDemoPilotReport(rejectedJournal(), "reconciliation");
    expect(report).toContain("Result: rejected proposal; no effect from that proposal");
    expect(report).toContain("Rejections: 1");
    expect(report).toContain("Time to first commit: not recorded");
    expect(report).not.toContain("run_journal_");
    expect(report).not.toContain("INV-");
  });

  it("does not hide a later terminal problem behind an earlier commit", () => {
    const journal = appendRunJournalEvent(committedJournal(), {
      category: "effect",
      outcome: "uncertain",
      summary: "Later effect outcome uncertain",
      occurredAt: "2026-07-12T00:00:06.000Z"
    });
    expect(() => createGuidedLocalDemoPilotReport(journal)).toThrow("Complete an approved or rejected local demo proposal");
  });

  it("uses only host-defined reconciliation metadata for the second sample", () => {
    const report = createGuidedLocalDemoPilotReport(committedJournal(), "reconciliation");
    expect(report).toContain("Invoice reconciliation sample pilot");
    expect(report).toContain("local invoice reconciliation with variance and exception review");
    expect(report).toContain("bundled synthetic ERP and payout values");
  });
});
