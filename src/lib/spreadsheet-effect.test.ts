import { describe, expect, it, vi } from "vitest";
import {
  SpreadsheetConflictError,
  SpreadsheetWriteRejectedError,
  SpreadsheetWriteUncertainError,
  type SpreadsheetConnector,
  type SpreadsheetRows
} from "./spreadsheet";
import {
  SpreadsheetEffectExecutor,
  decideSpreadsheetEffect,
  prepareSpreadsheetEffect,
  verifySpreadsheetEffect,
  type SpreadsheetEffectProposal
} from "./spreadsheet-effect";

const BASE: SpreadsheetRows = [["Owner", "Amount"], [" Aya ", 4]];
const DESIRED: SpreadsheetRows = [["Owner", "Amount"], ["Aya", 5]];

async function prepare(overrides: Partial<Parameters<typeof prepareSpreadsheetEffect>[0]> = {}) {
  return prepareSpreadsheetEffect({
    connector: { id: "test-sheet", version: "1.0.0" },
    target: { spreadsheetId: "sheet-1", range: "Ops!A1:B2" },
    baseValues: BASE,
    values: DESIRED,
    preconditionStrength: "recheck",
    policyDecisionId: "explicit-approval-v1",
    ...overrides
  });
}

function connector(current: SpreadsheetRows = BASE): SpreadsheetConnector {
  return {
    id: "test-sheet",
    label: "Test sheet",
    version: "1.0.0",
    read: vi.fn().mockResolvedValue({ spreadsheetId: "sheet-1", range: "Ops!A1:B2", values: current }),
    write: vi.fn().mockResolvedValue({
      updatedRange: "Ops!A1:B2",
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 2
    })
  };
}

describe("spreadsheet effect proposals", () => {
  it("creates a deterministic, deeply frozen content identity", async () => {
    const first = await prepare();
    const second = await prepare();

    expect(first.proposalId).toMatch(/^effect_[0-9a-f]{64}$/);
    expect(second.proposalId).toBe(first.proposalId);
    expect(first.baseVersion.value).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.summary).toEqual({ changedCells: 2, rows: 2, columns: 2 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.values)).toBe(true);
    expect(Object.isFrozen(first.values[1])).toBe(true);
    await expect(verifySpreadsheetEffect(first)).resolves.toBeUndefined();
  });

  it("copies caller-owned rows before freezing them", async () => {
    const base = BASE.map((row) => [...row]);
    const desired = DESIRED.map((row) => [...row]);
    const proposal = await prepare({ baseValues: base, values: desired });

    base[1][0] = "changed outside";
    desired[1][0] = "changed outside";

    expect(proposal.baseValues[1][0]).toBe(" Aya ");
    expect(proposal.values[1][0]).toBe("Aya");
  });

  it("rejects reconstructed content that reuses another proposal ID", async () => {
    const proposal = await prepare();
    const tampered = {
      ...proposal,
      values: [["Owner", "Amount"], ["Mallory", 999]]
    } as SpreadsheetEffectProposal;
    const adapter = connector();
    const executor = new SpreadsheetEffectExecutor();

    const outcome = await executor.execute(
      tampered,
      decideSpreadsheetEffect(proposal, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({ status: "failed", code: "invalid_proposal", phase: "proposal" });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("rejects unsupported fields instead of excluding them from the approval identity", async () => {
    const proposal = await prepare();
    const withHiddenField = { ...proposal, credential: "must-not-be-ignored" } as SpreadsheetEffectProposal;

    await expect(verifySpreadsheetEffect(withHiddenField)).rejects.toThrow("missing or unsupported fields");
  });

  it("rejects an approval bound to a different exact proposal", async () => {
    const first = await prepare();
    const second = await prepare({ values: [["Owner", "Amount"], ["Aya", 6]] });
    const adapter = connector();

    const outcome = await new SpreadsheetEffectExecutor().execute(
      second,
      decideSpreadsheetEffect(first, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({ status: "failed", code: "invalid_approval", phase: "approval" });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});

describe("SpreadsheetEffectExecutor", () => {
  it("rechecks the base snapshot, commits once, and returns a bound receipt", async () => {
    const proposal = await prepare();
    const adapter = connector();
    const executor = new SpreadsheetEffectExecutor(() => new Date("2026-07-12T00:00:00.000Z"));
    const approval = decideSpreadsheetEffect(proposal, "approve", "foreground-user", "2026-07-11T23:59:00.000Z");

    const outcome = await executor.execute(proposal, approval, adapter);

    expect(outcome).toMatchObject({
      status: "committed",
      proposalId: proposal.proposalId,
      receipt: {
        receiptId: `receipt:${proposal.proposalId}`,
        baseVersion: { kind: "snapshot-hash", value: proposal.baseVersion.value },
        preconditionStrength: "recheck",
        committedAt: "2026-07-12T00:00:00.000Z"
      }
    });
    expect(adapter.read).toHaveBeenCalledWith(proposal.target, undefined);
    expect(adapter.write).toHaveBeenCalledWith({ ...proposal.target, values: proposal.values }, undefined);

    const duplicate = await executor.execute(proposal, approval, adapter);
    expect(duplicate).toMatchObject({ status: "failed", code: "proposal_already_consumed" });
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it("turns a changed source into a terminal conflict without writing", async () => {
    const proposal = await prepare();
    const adapter = connector([["Owner", "Amount"], ["Someone else", 4]]);
    const executor = new SpreadsheetEffectExecutor();
    const approval = decideSpreadsheetEffect(proposal, "approve", "foreground-user");

    const outcome = await executor.execute(proposal, approval, adapter);

    expect(outcome).toMatchObject({
      status: "conflict",
      expectedBaseVersion: { kind: "snapshot-hash", value: proposal.baseVersion.value },
      preconditionStrength: "recheck",
      observedValues: [["Owner", "Amount"], ["Someone else", 4]]
    });
    expect(adapter.write).not.toHaveBeenCalled();
    const duplicate = await executor.execute(proposal, approval, adapter);
    expect(duplicate).toMatchObject({ status: "failed", code: "proposal_already_consumed" });
  });

  it("records an uncertain terminal outcome and never retries the same proposal", async () => {
    const proposal = await prepare();
    const adapter = connector();
    vi.mocked(adapter.write).mockRejectedValue(new SpreadsheetWriteUncertainError());
    const executor = new SpreadsheetEffectExecutor();
    const approval = decideSpreadsheetEffect(proposal, "approve", "foreground-user");

    const outcome = await executor.execute(proposal, approval, adapter);

    expect(outcome).toMatchObject({ status: "uncertain", reconciliationRequired: true });
    const duplicate = await executor.execute(proposal, approval, adapter);
    expect(duplicate).toMatchObject({ status: "failed", code: "proposal_already_consumed" });
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a typed provider rejection from an unclassified commit error", async () => {
    const rejectedProposal = await prepare({ values: [["Owner", "Amount"], ["Aya", 6]] });
    const rejectedAdapter = connector();
    vi.mocked(rejectedAdapter.write).mockRejectedValue(new SpreadsheetWriteRejectedError("Policy rejected the write."));
    const rejected = await new SpreadsheetEffectExecutor().execute(
      rejectedProposal,
      decideSpreadsheetEffect(rejectedProposal, "approve", "foreground-user"),
      rejectedAdapter
    );

    const unknownProposal = await prepare({ values: [["Owner", "Amount"], ["Aya", 7]] });
    const unknownAdapter = connector();
    vi.mocked(unknownAdapter.write).mockRejectedValue(new Error("unclassified transport detail"));
    const unknown = await new SpreadsheetEffectExecutor().execute(
      unknownProposal,
      decideSpreadsheetEffect(unknownProposal, "approve", "foreground-user"),
      unknownAdapter
    );

    expect(rejected).toMatchObject({ status: "failed", code: "provider_rejected_write", reason: "Policy rejected the write." });
    expect(unknown).toMatchObject({ status: "uncertain", reconciliationRequired: true });
    if (unknown.status === "uncertain") expect(unknown.reason).not.toContain("unclassified transport detail");
  });

  it("allows a safe validation read to be retried because no mutation was sent", async () => {
    const proposal = await prepare();
    const adapter = connector();
    vi.mocked(adapter.read)
      .mockRejectedValueOnce(new Error("Temporary read failure"))
      .mockResolvedValueOnce({ spreadsheetId: "sheet-1", range: "Ops!A1:B2", values: BASE });
    const executor = new SpreadsheetEffectExecutor();
    const approval = decideSpreadsheetEffect(proposal, "approve", "foreground-user");

    const first = await executor.execute(proposal, approval, adapter);
    const second = await executor.execute(proposal, approval, adapter);

    expect(first).toMatchObject({ status: "failed", code: "source_recheck_failed", retryable: true });
    expect(second.status).toBe("committed");
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it("records a rejection without requiring connector credentials or reads", async () => {
    const proposal = await prepare();
    const executor = new SpreadsheetEffectExecutor();

    const outcome = await executor.reject(
      proposal,
      decideSpreadsheetEffect(proposal, "reject", "foreground-user", "2026-07-12T00:00:00.000Z")
    );

    expect(outcome).toEqual({
      status: "rejected",
      proposalId: proposal.proposalId,
      actor: "foreground-user",
      decidedAt: "2026-07-12T00:00:00.000Z"
    });
  });

  it("blocks proposals without a usable source precondition", async () => {
    const proposal = await prepare({ preconditionStrength: "none" });
    const adapter = connector();

    const outcome = await new SpreadsheetEffectExecutor().execute(
      proposal,
      decideSpreadsheetEffect(proposal, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({ status: "failed", code: "precondition_unavailable" });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("requires a provider-native version for atomic proposals", async () => {
    await expect(prepare({ preconditionStrength: "atomic" })).rejects.toThrow("must be an object");
    await expect(prepare({
      preconditionStrength: "atomic",
      providerVersion: { kind: "snapshot-hash", value: "not-atomic" }
    })).rejects.toThrow("ETag, revision, or sequence");
  });

  it("passes an atomic provider version into one conditional write without a recheck read", async () => {
    const proposal = await prepare({
      preconditionStrength: "atomic",
      providerVersion: { kind: "revision", value: "revision-7" }
    });
    const adapter = connector();
    adapter.writeConditional = vi.fn().mockResolvedValue({
      updatedRange: "Ops!A1:B2",
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 2
    });

    const outcome = await new SpreadsheetEffectExecutor().execute(
      proposal,
      decideSpreadsheetEffect(proposal, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({
      status: "committed",
      receipt: { baseVersion: { kind: "revision", value: "revision-7" }, preconditionStrength: "atomic" }
    });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.writeConditional).toHaveBeenCalledWith(
      { ...proposal.target, values: proposal.values },
      { kind: "revision", value: "revision-7" },
      undefined
    );
  });

  it("blocks an atomic proposal when the active connector lacks conditional write support", async () => {
    const proposal = await prepare({
      preconditionStrength: "atomic",
      providerVersion: { kind: "etag", value: "etag-7" }
    });
    const adapter = connector();

    const outcome = await new SpreadsheetEffectExecutor().execute(
      proposal,
      decideSpreadsheetEffect(proposal, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({ status: "failed", code: "atomic_commit_unsupported" });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("maps a provider-native stale version to a typed atomic conflict", async () => {
    const proposal = await prepare({
      preconditionStrength: "atomic",
      providerVersion: { kind: "revision", value: "revision-7" }
    });
    const adapter = connector();
    adapter.writeConditional = vi.fn().mockRejectedValue(new SpreadsheetConflictError(
      "revision changed",
      { kind: "revision", value: "revision-8" },
      [["Owner", "Amount"], ["External edit", 4]]
    ));

    const outcome = await new SpreadsheetEffectExecutor().execute(
      proposal,
      decideSpreadsheetEffect(proposal, "approve", "foreground-user"),
      adapter
    );

    expect(outcome).toMatchObject({
      status: "conflict",
      preconditionStrength: "atomic",
      expectedBaseVersion: { kind: "revision", value: "revision-7" },
      observedBaseVersion: { kind: "revision", value: "revision-8" },
      observedValues: [["Owner", "Amount"], ["External edit", 4]]
    });
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});
