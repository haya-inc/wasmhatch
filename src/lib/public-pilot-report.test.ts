import { describe, expect, it } from "vitest";
import { appendRunJournalEvent, createRunJournal } from "./run-journal";
import { createGuidedLocalDemoPilotReport, createPublicPilotReport } from "./public-pilot-report";

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
    expect(report).toContain("External account or OAuth used: no");
    expect(report).toContain("Model requests recorded: no");
    expect(report).toContain("WasmHatch server or source upload used: no");
    expect(report).not.toContain("run_journal_");
    expect(report).not.toContain("aya tanaka");
    expect(new TextEncoder().encode(report).byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  it("requires a committed, approved proposal", () => {
    const journal = createRunJournal({
      runId: `run_journal_${"b".repeat(32)}`,
      startedAt: "2026-07-12T00:00:00.000Z"
    });
    expect(() => createGuidedLocalDemoPilotReport(journal)).toThrow("Complete an approved or rejected effect proposal");
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
    expect(() => createGuidedLocalDemoPilotReport(journal)).toThrow("Complete an approved or rejected effect proposal");
  });

  it("uses only host-defined reconciliation metadata for the second sample", () => {
    const report = createGuidedLocalDemoPilotReport(committedJournal(), "reconciliation");
    expect(report).toContain("Invoice reconciliation sample pilot");
    expect(report).toContain("local invoice reconciliation with variance and exception review");
    expect(report).toContain("bundled synthetic ERP and payout values");
  });

  it("uses generic host metadata for real local files without leaking identities", () => {
    const csv = createPublicPilotReport(committedJournal(), "local-csv");
    const xlsx = createPublicPilotReport(rejectedJournal(), "local-xlsx");
    expect(csv).toContain("Local CSV workflow pilot");
    expect(csv).toContain("user-selected CSV parsed in a browser Worker");
    expect(xlsx).toContain("Local XLSX workflow pilot");
    expect(xlsx).toContain("user-selected XLSX normalized in a browser Worker");
    expect(`${csv}\n${xlsx}`).not.toContain("customer.xlsx");
    expect(`${csv}\n${xlsx}`).not.toContain("Sheet1");
  });

  it("discloses foreground Google authority without including its target", () => {
    const report = createPublicPilotReport(committedJournal(), "google-sheets");
    expect(report).toContain("Google Sheets workflow pilot");
    expect(report).toContain("External account or OAuth used: foreground Google account and OAuth");
    expect(report).toContain("WasmHatch server or source upload used: no");
    expect(report).not.toContain("spreadsheetId");
    expect(report).not.toContain("Sheet1!");
  });
});
