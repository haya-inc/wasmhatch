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
    expect(() => createGuidedLocalDemoPilotReport(journal)).toThrow("Complete an approved local demo effect");
  });
});
