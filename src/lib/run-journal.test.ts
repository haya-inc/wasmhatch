import { describe, expect, it } from "vitest";
import {
  appendRunJournalEvent,
  buildRunJournalExport,
  createPolicyDecisionEnvelope,
  createRunJournal,
  redactRunJournalText,
  RUN_JOURNAL_LIMITS,
  serializeRunJournal
} from "./run-journal";

const RUN_ID = `run_journal_${"1".repeat(32)}`;
const DECISION_ID = `policy_decision_${"2".repeat(32)}`;

function journal() {
  return createRunJournal({ runId: RUN_ID, startedAt: "2026-07-12T00:00:00.000Z" });
}

describe("run journal", () => {
  it("derives pilot metrics from structured proposal, approval, and commit events", () => {
    let value = journal();
    value = appendRunJournalEvent(value, {
      category: "script",
      outcome: "completed",
      summary: "Sandbox script completed",
      occurredAt: "2026-07-12T00:00:10.000Z"
    });
    value = appendRunJournalEvent(value, {
      category: "proposal",
      outcome: "prepared",
      summary: "Spreadsheet proposal prepared",
      evidence: { changed_cells: 12, proposal_id: "effect_abc" },
      occurredAt: "2026-07-12T00:00:20.000Z"
    });
    value = appendRunJournalEvent(value, {
      category: "approval",
      outcome: "approved",
      summary: "Foreground user approved",
      occurredAt: "2026-07-12T00:00:30.000Z"
    });
    value = appendRunJournalEvent(value, {
      category: "effect",
      outcome: "committed",
      summary: "Spreadsheet effect committed",
      occurredAt: "2026-07-12T00:00:40.000Z"
    });

    expect(value.state).toBe("committed");
    expect(value.metrics).toMatchObject({
      elapsedMs: 40_000,
      scriptRuns: 1,
      proposalsPrepared: 1,
      approvals: 1,
      commits: 1,
      timeToFirstProposalMs: 20_000,
      timeToFirstCommitMs: 40_000
    });
    expect(value.events[1].evidence).toEqual({ changed_cells: 12, proposal_id: "effect_abc" });
    expect(Object.isFrozen(value.events)).toBe(true);
  });

  it("records conflicts and uncertain outcomes as needs-attention evidence", () => {
    let value = appendRunJournalEvent(journal(), {
      category: "effect",
      outcome: "conflict",
      summary: "Source conflict",
      occurredAt: "2026-07-12T00:00:01.000Z"
    });
    value = appendRunJournalEvent(value, {
      category: "effect",
      outcome: "uncertain",
      summary: "Provider outcome uncertain",
      occurredAt: "2026-07-12T00:00:02.000Z"
    });
    expect(value.state).toBe("needs_attention");
    expect(value.metrics.conflicts).toBe(1);
    expect(value.metrics.uncertainOutcomes).toBe(1);
  });

  it("redacts credential-shaped text from events, task context, and resources", () => {
    expect(redactRunJournalText("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization header [REDACTED]");
    expect(redactRunJournalText("key sk-proj-abcdefghijklmno")).not.toContain("abcdefghijklmno");
    let value = appendRunJournalEvent(journal(), {
      category: "model",
      outcome: "failed",
      summary: "Provider rejected api_key=sk-proj-abcdefghijklmno",
      detail: "Bearer abcdefghijklmnop"
    });
    const exported = buildRunJournalExport(value, {
      task: "Use sk-ant-abcdefghijklmno to normalize rows",
      source: {
        kind: "google",
        connectorId: "google-sheets",
        resource: "Authorization: Bearer abcdefghijklmnop",
        sourceSha256: null
      }
    });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("abcdefghijklmno");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(exported.privacy.credentialFieldsIncluded).toBe(false);
    expect(exported.privacy.sourceContentsIncluded).toBe(false);
    expect(exported.privacy.defensiveRedactionApplied).toBe(true);
  });

  it("rejects evidence fields that could carry credentials", () => {
    expect(() => appendRunJournalEvent(journal(), {
      category: "system",
      outcome: "info",
      summary: "Unsafe evidence",
      evidence: { access_token: "do-not-record" }
    })).toThrow("may contain a credential");
  });

  it("creates a bounded policy decision envelope that can bind an effect proposal", () => {
    const decision = createPolicyDecisionEnvelope({
      decisionId: DECISION_ID,
      decidedAt: "2026-07-12T00:00:00.000Z",
      policyId: "foreground-explicit-approval-v1",
      capability: "spreadsheet.cells.update",
      resource: "local-spreadsheet:Demo!A1",
      decision: "stage",
      actor: "host-policy",
      reason: "Prepare a reviewable proposal; do not commit without foreground approval."
    });
    expect(decision.decisionId).toBe(DECISION_ID);
    expect(decision.decision).toBe("stage");
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("serializes an inspectable export without source contents", () => {
    const serialized = serializeRunJournal(journal(), {
      task: "Normalize the weekly pipeline",
      source: {
        kind: "artifact",
        connectorId: null,
        resource: "inputs/pipeline.json",
        sourceSha256: `sha256:${"a".repeat(64)}`
      }
    });
    const value = JSON.parse(serialized) as Record<string, unknown>;
    expect(value.schemaVersion).toBe(1);
    expect(value.context).toEqual({
      task: "Normalize the weekly pipeline",
      source: {
        kind: "artifact",
        connectorId: null,
        resource: "inputs/pipeline.json",
        sourceSha256: `sha256:${"a".repeat(64)}`
      }
    });
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("reserves the final journal slots for review and effect outcomes", () => {
    let value = journal();
    const ordinaryLimit = RUN_JOURNAL_LIMITS.maxEvents - RUN_JOURNAL_LIMITS.reservedTerminalEvents;
    for (let index = 0; index < ordinaryLimit; index += 1) {
      value = appendRunJournalEvent(value, {
        category: "tool",
        outcome: "completed",
        summary: `Bounded tool event ${index + 1}`,
        occurredAt: new Date(Date.parse("2026-07-12T00:00:00.000Z") + index).toISOString()
      });
    }
    expect(() => appendRunJournalEvent(value, {
      category: "tool",
      outcome: "completed",
      summary: "Would consume a terminal slot"
    })).toThrow("terminal review/effect slots are reserved");
    value = appendRunJournalEvent(value, {
      category: "approval",
      outcome: "approved",
      summary: "Exact proposal approved"
    });
    value = appendRunJournalEvent(value, {
      category: "effect",
      outcome: "committed",
      summary: "Exact proposal committed"
    });
    expect(value.events).toHaveLength(ordinaryLimit + 2);
    expect(value.state).toBe("committed");
  });
});
