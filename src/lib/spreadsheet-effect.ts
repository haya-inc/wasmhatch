import {
  SpreadsheetConflictError,
  SpreadsheetWriteRejectedError,
  SpreadsheetWriteUncertainError,
  validateSpreadsheetRows,
  type SpreadsheetConnector,
  type SpreadsheetRows,
  type SpreadsheetVersion,
  type SpreadsheetWriteResult
} from "./spreadsheet";
import {
  UnsupportedTabularEffectError,
  applySpreadsheetMutationBundle,
  countFormulaMutations,
  createSpreadsheetMutationBundle,
  invertSpreadsheetMutationBundle,
  type SpreadsheetInputMode,
  type SpreadsheetMutationBundle
} from "./spreadsheet-mutation";

export type PreconditionStrength = "atomic" | "recheck" | "none";

export interface SpreadsheetEffectProposal {
  readonly schemaVersion: 2;
  readonly proposalId: string;
  readonly operation: "spreadsheet.cells.update";
  readonly connector: {
    readonly id: string;
    readonly version: string;
  };
  readonly target: {
    readonly spreadsheetId: string;
    readonly range: string;
    readonly inputMode: "RAW" | "USER_ENTERED";
  };
  readonly baseVersion: {
    readonly kind: SpreadsheetVersion["kind"];
    readonly value: string;
    readonly strength: PreconditionStrength;
  };
  readonly baseValues: SpreadsheetRows;
  readonly mutations: SpreadsheetMutationBundle;
  readonly summary: {
    readonly changedCells: number;
    readonly formulaCells: number;
    readonly rows: number;
    readonly columns: number;
  };
  readonly policyDecisionId: string;
  readonly expiresAt: string | null;
}

export interface PrepareSpreadsheetEffectInput {
  connector: { id: string; version: string };
  target: { spreadsheetId: string; range: string; inputMode?: "RAW" | "USER_ENTERED" };
  baseValues: SpreadsheetRows;
  values: SpreadsheetRows;
  preconditionStrength: PreconditionStrength;
  providerVersion?: SpreadsheetVersion;
  policyDecisionId: string;
  expiresAt?: string | null;
}

export interface PrepareSpreadsheetReversalInput {
  committedProposal: SpreadsheetEffectProposal;
  receipt: SpreadsheetCommitReceipt;
  currentValues: SpreadsheetRows;
  policyDecisionId: string;
  expiresAt?: string | null;
}

export interface SpreadsheetApproval {
  readonly interruptId: string;
  readonly proposalId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly decidedAt: string;
}

export interface SpreadsheetCommitReceipt {
  readonly receiptId: string;
  readonly proposalId: string;
  readonly connector: { readonly id: string; readonly version: string };
  readonly target: { readonly spreadsheetId: string; readonly range: string };
  readonly baseVersion: SpreadsheetVersion;
  readonly preconditionStrength: PreconditionStrength;
  readonly providerResult: SpreadsheetWriteResult;
  readonly mutations: {
    readonly count: number;
    readonly inverse: SpreadsheetMutationBundle;
  };
  readonly committedAt: string;
}

export type SpreadsheetEffectOutcome =
  | { status: "committed"; proposalId: string; receipt: SpreadsheetCommitReceipt }
  | { status: "rejected"; proposalId: string; actor: string; decidedAt: string }
  | {
      status: "conflict";
      proposalId: string;
      expectedBaseVersion: SpreadsheetVersion;
      observedBaseVersion: SpreadsheetVersion | null;
      observedValues: SpreadsheetRows | null;
      preconditionStrength: PreconditionStrength;
    }
  | {
      status: "uncertain";
      proposalId: string;
      reason: string;
      reconciliationRequired: true;
    }
  | {
      status: "failed";
      proposalId: string;
      phase: "proposal" | "approval" | "validation" | "commit";
      code: string;
      reason: string;
      retryable: boolean;
    };

const HASH_PREFIX = "sha256:";
const PROPOSAL_PREFIX = "effect_";
const POLICY_ID_MAX_LENGTH = 256;
const TARGET_TEXT_MAX_LENGTH = 256;

function requireText(value: string, label: string, maxLength = TARGET_TEXT_MAX_LENGTH) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters.`);
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Effect identity contains a non-JSON value.");
}

async function sha256(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this browser.");
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneRows(value: unknown) {
  return validateSpreadsheetRows(value).map((row) => [...row]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function dimensions(rows: SpreadsheetRows) {
  return {
    rows: rows.length,
    columns: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  };
}

async function hashRows(rows: SpreadsheetRows) {
  return `${HASH_PREFIX}${await sha256({ schemaVersion: 1, values: rows })}`;
}

function proposalIdentity(proposal: Omit<SpreadsheetEffectProposal, "proposalId"> | SpreadsheetEffectProposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    operation: proposal.operation,
    connector: proposal.connector,
    target: proposal.target,
    baseVersion: proposal.baseVersion,
    baseValues: proposal.baseValues,
    mutations: proposal.mutations,
    summary: proposal.summary,
    policyDecisionId: proposal.policyDecisionId,
    expiresAt: proposal.expiresAt
  };
}

function validateExpiry(value: string | null) {
  if (value !== null && !Number.isFinite(Date.parse(value))) {
    throw new Error("Effect expiry must be an ISO date-time or null.");
  }
  return value;
}

function assertExactKeys(value: unknown, expectedKeys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expected)) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function validatePreconditionStrength(value: unknown): PreconditionStrength {
  if (value !== "atomic" && value !== "recheck" && value !== "none") {
    throw new Error("Unsupported spreadsheet precondition strength.");
  }
  return value;
}

function validateInputMode(value: unknown): SpreadsheetInputMode {
  if (value !== "RAW" && value !== "USER_ENTERED") {
    throw new Error("Spreadsheet proposal input mode is unsupported.");
  }
  return value;
}

function validateProviderVersion(value: unknown): SpreadsheetVersion {
  assertExactKeys(value, ["kind", "value"], "Spreadsheet provider version");
  const version = value as SpreadsheetVersion;
  if (version.kind !== "etag" && version.kind !== "revision" && version.kind !== "sequence") {
    throw new Error("Atomic spreadsheet proposals require an ETag, revision, or sequence version.");
  }
  return { kind: version.kind, value: requireText(version.value, "Provider version") };
}

export async function prepareSpreadsheetEffect(
  input: PrepareSpreadsheetEffectInput
): Promise<SpreadsheetEffectProposal> {
  const baseValues = cloneRows(input.baseValues);
  const values = cloneRows(input.values);
  const inputMode = validateInputMode(input.target.inputMode ?? "RAW");
  const mutations = createSpreadsheetMutationBundle(baseValues, values, inputMode);
  const changedCells = mutations.mutations.length;
  if (changedCells === 0) throw new Error("The transform produced no spreadsheet changes.");
  const formulaCells = countFormulaMutations(mutations);
  if (formulaCells > 0) {
    throw new UnsupportedTabularEffectError(
      "formula_write_requires_capability",
      "Formula writes require a separate high-risk capability and cannot use the ordinary cell-update proposal."
    );
  }

  const size = dimensions(values);
  const preconditionStrength = validatePreconditionStrength(input.preconditionStrength);
  const snapshotVersion = await hashRows(baseValues);
  const baseVersion = preconditionStrength === "atomic"
    ? { ...validateProviderVersion(input.providerVersion), strength: preconditionStrength }
    : { kind: "snapshot-hash" as const, value: snapshotVersion, strength: preconditionStrength };
  if (preconditionStrength !== "atomic" && input.providerVersion !== undefined) {
    throw new Error("Provider versions are accepted only for atomic spreadsheet proposals.");
  }
  const proposalWithoutId: Omit<SpreadsheetEffectProposal, "proposalId"> = {
    schemaVersion: 2,
    operation: "spreadsheet.cells.update",
    connector: {
      id: requireText(input.connector.id, "Connector ID"),
      version: requireText(input.connector.version, "Connector version")
    },
    target: {
      spreadsheetId: requireText(input.target.spreadsheetId, "Spreadsheet ID"),
      range: requireText(input.target.range, "Spreadsheet range"),
      inputMode
    },
    baseVersion,
    baseValues,
    mutations,
    summary: { changedCells, formulaCells, ...size },
    policyDecisionId: requireText(input.policyDecisionId, "Policy decision ID", POLICY_ID_MAX_LENGTH),
    expiresAt: validateExpiry(input.expiresAt ?? null)
  };
  const proposalId = `${PROPOSAL_PREFIX}${await sha256(proposalIdentity(proposalWithoutId))}`;
  return deepFreeze({ ...proposalWithoutId, proposalId });
}

/**
 * Turns a proven commit receipt into a new reviewable proposal. A reversal is
 * never an instruction to write immediately: it receives a new proposal ID,
 * policy decision, current-source recheck, and foreground approval.
 */
export async function prepareSpreadsheetReversalEffect(
  input: PrepareSpreadsheetReversalInput
): Promise<SpreadsheetEffectProposal> {
  const committedValues = await verifySpreadsheetEffect(input.committedProposal);
  const currentValues = cloneRows(input.currentValues);
  const { committedProposal, receipt } = input;

  assertExactKeys(receipt, [
    "receiptId", "proposalId", "connector", "target", "baseVersion",
    "preconditionStrength", "providerResult", "mutations", "committedAt"
  ], "Spreadsheet commit receipt");
  assertExactKeys(receipt.connector, ["id", "version"], "Spreadsheet commit receipt connector");
  assertExactKeys(receipt.target, ["spreadsheetId", "range"], "Spreadsheet commit receipt target");
  assertExactKeys(receipt.baseVersion, ["kind", "value"], "Spreadsheet commit receipt base version");
  assertExactKeys(receipt.providerResult, ["updatedRange", "updatedRows", "updatedColumns", "updatedCells"], "Spreadsheet commit provider result");
  assertExactKeys(receipt.mutations, ["count", "inverse"], "Spreadsheet commit receipt mutations");
  if (
    receipt.receiptId !== `receipt:${committedProposal.proposalId}` ||
    receipt.proposalId !== committedProposal.proposalId ||
    receipt.connector.id !== committedProposal.connector.id ||
    receipt.connector.version !== committedProposal.connector.version ||
    receipt.target.spreadsheetId !== committedProposal.target.spreadsheetId ||
    receipt.target.range !== committedProposal.target.range ||
    receipt.preconditionStrength !== committedProposal.baseVersion.strength ||
    canonicalJson(receipt.baseVersion) !== canonicalJson({
      kind: committedProposal.baseVersion.kind,
      value: committedProposal.baseVersion.value
    }) ||
    receipt.mutations.count !== committedProposal.mutations.mutations.length
  ) {
    throw new Error("Spreadsheet reversal receipt does not match the committed proposal.");
  }
  if (!Number.isFinite(Date.parse(receipt.committedAt))) {
    throw new Error("Spreadsheet reversal receipt has an invalid commit time.");
  }
  requireText(receipt.providerResult.updatedRange, "Spreadsheet commit updated range");
  for (const [label, value] of Object.entries({
    rows: receipt.providerResult.updatedRows,
    columns: receipt.providerResult.updatedColumns,
    cells: receipt.providerResult.updatedCells
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Spreadsheet commit updated ${label} must be a non-negative integer.`);
    }
  }

  const expectedInverse = invertSpreadsheetMutationBundle(
    committedProposal.baseValues,
    committedProposal.mutations,
    committedProposal.target.inputMode
  );
  if (canonicalJson(receipt.mutations.inverse) !== canonicalJson(expectedInverse)) {
    throw new Error("Spreadsheet reversal receipt contains a different inverse mutation bundle.");
  }
  if (canonicalJson(currentValues) !== canonicalJson(committedValues)) {
    throw new Error("The current spreadsheet no longer matches the committed result; prepare a new operation instead of reversing it.");
  }

  const revertedValues = applySpreadsheetMutationBundle(
    currentValues,
    receipt.mutations.inverse,
    committedProposal.target.inputMode
  );
  if (canonicalJson(revertedValues) !== canonicalJson(committedProposal.baseValues)) {
    throw new Error("Spreadsheet reversal did not reconstruct the committed base snapshot.");
  }

  return prepareSpreadsheetEffect({
    connector: committedProposal.connector,
    target: committedProposal.target,
    baseValues: currentValues,
    values: revertedValues,
    preconditionStrength: "recheck",
    policyDecisionId: input.policyDecisionId,
    expiresAt: input.expiresAt
  });
}

export async function verifySpreadsheetEffect(proposal: SpreadsheetEffectProposal): Promise<SpreadsheetRows> {
  assertExactKeys(proposal, [
    "schemaVersion", "proposalId", "operation", "connector", "target", "baseVersion",
    "baseValues", "mutations", "summary", "policyDecisionId", "expiresAt"
  ], "Spreadsheet proposal");
  assertExactKeys(proposal.connector, ["id", "version"], "Spreadsheet proposal connector");
  assertExactKeys(proposal.target, ["spreadsheetId", "range", "inputMode"], "Spreadsheet proposal target");
  assertExactKeys(proposal.baseVersion, ["kind", "value", "strength"], "Spreadsheet proposal base version");
  assertExactKeys(proposal.summary, ["changedCells", "formulaCells", "rows", "columns"], "Spreadsheet proposal summary");
  if (proposal.schemaVersion !== 2 || proposal.operation !== "spreadsheet.cells.update") {
    throw new Error("Unsupported spreadsheet proposal schema or operation.");
  }
  if (!/^effect_[0-9a-f]{64}$/.test(proposal.proposalId)) throw new Error("Spreadsheet proposal ID is malformed.");
  requireText(proposal.connector.id, "Connector ID");
  requireText(proposal.connector.version, "Connector version");
  requireText(proposal.target.spreadsheetId, "Spreadsheet ID");
  requireText(proposal.target.range, "Spreadsheet range");
  requireText(proposal.policyDecisionId, "Policy decision ID", POLICY_ID_MAX_LENGTH);
  const inputMode = validateInputMode(proposal.target.inputMode);
  const strength = validatePreconditionStrength(proposal.baseVersion.strength);
  const baseValues = cloneRows(proposal.baseValues);
  const values = applySpreadsheetMutationBundle(baseValues, proposal.mutations, inputMode);
  const expectedBaseVersion = await hashRows(baseValues);
  if (strength === "atomic") {
    validateProviderVersion({ kind: proposal.baseVersion.kind, value: proposal.baseVersion.value });
  } else if (proposal.baseVersion.kind !== "snapshot-hash" || proposal.baseVersion.value !== expectedBaseVersion) {
    throw new Error("Spreadsheet proposal base snapshot does not match its version.");
  }
  const expectedSummary = {
    changedCells: proposal.mutations.mutations.length,
    formulaCells: countFormulaMutations(proposal.mutations),
    ...dimensions(values)
  };
  if (canonicalJson(proposal.summary) !== canonicalJson(expectedSummary) || expectedSummary.changedCells === 0) {
    throw new Error("Spreadsheet proposal summary does not match its mutations.");
  }
  if (expectedSummary.formulaCells > 0) {
    throw new Error("Spreadsheet proposal contains formula mutations without the required capability.");
  }
  validateExpiry(proposal.expiresAt);
  const expectedId = `${PROPOSAL_PREFIX}${await sha256(proposalIdentity(proposal))}`;
  if (proposal.proposalId !== expectedId) throw new Error("Spreadsheet proposal identity does not match its content.");
  return values;
}

export function decideSpreadsheetEffect(
  proposal: SpreadsheetEffectProposal,
  decision: "approve" | "reject",
  actor: string,
  decidedAt = new Date().toISOString()
): SpreadsheetApproval {
  const normalizedActor = requireText(actor, "Approval actor");
  if (!Number.isFinite(Date.parse(decidedAt))) throw new Error("Approval time must be an ISO date-time.");
  return deepFreeze({
    interruptId: `approval:${proposal.proposalId}`,
    proposalId: proposal.proposalId,
    decision,
    actor: normalizedActor,
    decidedAt
  });
}

function failed(
  proposalId: string,
  phase: Extract<SpreadsheetEffectOutcome, { status: "failed" }>["phase"],
  code: string,
  reason: string,
  retryable = false
): SpreadsheetEffectOutcome {
  return { status: "failed", proposalId, phase, code, reason, retryable };
}

function approvalFailure(proposal: SpreadsheetEffectProposal, approval: SpreadsheetApproval) {
  if (approval.proposalId !== proposal.proposalId || approval.interruptId !== `approval:${proposal.proposalId}`) {
    return "Approval does not name this exact spreadsheet proposal.";
  }
  if (!approval.actor.trim() || !Number.isFinite(Date.parse(approval.decidedAt))) {
    return "Approval actor or decision time is invalid.";
  }
  return null;
}

export class SpreadsheetEffectExecutor {
  private readonly attempts = new Map<string, "in_progress" | SpreadsheetEffectOutcome["status"]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private alreadyAttempted(proposalId: string) {
    const state = this.attempts.get(proposalId);
    return state
      ? failed(proposalId, "approval", "proposal_already_consumed", `This proposal is already ${state}; prepare and approve a new proposal.`)
      : null;
  }

  async reject(
    proposal: SpreadsheetEffectProposal,
    approval: SpreadsheetApproval
  ): Promise<SpreadsheetEffectOutcome> {
    try {
      await verifySpreadsheetEffect(proposal);
    } catch (error) {
      return failed(proposal.proposalId, "proposal", "invalid_proposal", error instanceof Error ? error.message : "Invalid spreadsheet proposal.");
    }
    const duplicate = this.alreadyAttempted(proposal.proposalId);
    if (duplicate) return duplicate;
    const approvalError = approvalFailure(proposal, approval);
    if (approvalError || approval.decision !== "reject") {
      return failed(proposal.proposalId, "approval", "invalid_rejection", approvalError ?? "A rejection decision is required.");
    }
    const outcome: SpreadsheetEffectOutcome = {
      status: "rejected",
      proposalId: proposal.proposalId,
      actor: approval.actor,
      decidedAt: approval.decidedAt
    };
    this.attempts.set(proposal.proposalId, outcome.status);
    return outcome;
  }

  async execute(
    proposal: SpreadsheetEffectProposal,
    approval: SpreadsheetApproval,
    connector: SpreadsheetConnector,
    signal?: AbortSignal
  ): Promise<SpreadsheetEffectOutcome> {
    let committedValues: SpreadsheetRows;
    try {
      committedValues = await verifySpreadsheetEffect(proposal);
    } catch (error) {
      return failed(proposal.proposalId, "proposal", "invalid_proposal", error instanceof Error ? error.message : "Invalid spreadsheet proposal.");
    }

    const duplicate = this.alreadyAttempted(proposal.proposalId);
    if (duplicate) return duplicate;
    const approvalError = approvalFailure(proposal, approval);
    if (approvalError || approval.decision !== "approve") {
      return failed(proposal.proposalId, "approval", "invalid_approval", approvalError ?? "An approval decision is required.");
    }
    if (proposal.expiresAt !== null && this.now().getTime() >= Date.parse(proposal.expiresAt)) {
      this.attempts.set(proposal.proposalId, "failed");
      return failed(proposal.proposalId, "approval", "proposal_expired", "This proposal expired; prepare and approve a new proposal.");
    }
    if (connector.id !== proposal.connector.id || connector.version !== proposal.connector.version) {
      return failed(proposal.proposalId, "validation", "connector_mismatch", "The active connector does not match the approved proposal.");
    }
    if (proposal.baseVersion.strength === "none") {
      this.attempts.set(proposal.proposalId, "failed");
      return failed(proposal.proposalId, "validation", "precondition_unavailable", "This effect has no source precondition and is blocked by default.");
    }
    if (proposal.baseVersion.strength === "atomic" && !connector.writeConditional) {
      return failed(
        proposal.proposalId,
        "validation",
        "atomic_commit_unsupported",
        "The active connector cannot send the approved provider version in the same conditional write."
      );
    }

    this.attempts.set(proposal.proposalId, "in_progress");
    let committedBaseVersion: SpreadsheetVersion = {
      kind: proposal.baseVersion.kind,
      value: proposal.baseVersion.value
    };
    if (proposal.baseVersion.strength === "recheck") {
      let currentValues: SpreadsheetRows;
      try {
        const current = await connector.read(proposal.target, signal);
        currentValues = cloneRows(current.values);
      } catch (error) {
        this.attempts.delete(proposal.proposalId);
        return failed(
          proposal.proposalId,
          "validation",
          "source_recheck_failed",
          error instanceof Error ? error.message : "The source could not be rechecked.",
          true
        );
      }

      const observedVersion: SpreadsheetVersion = { kind: "snapshot-hash", value: await hashRows(currentValues) };
      committedBaseVersion = observedVersion;
      if (observedVersion.value !== proposal.baseVersion.value) {
        const outcome: SpreadsheetEffectOutcome = {
          status: "conflict",
          proposalId: proposal.proposalId,
          expectedBaseVersion: { kind: proposal.baseVersion.kind, value: proposal.baseVersion.value },
          observedBaseVersion: observedVersion,
          observedValues: currentValues,
          preconditionStrength: proposal.baseVersion.strength
        };
        this.attempts.set(proposal.proposalId, outcome.status);
        return outcome;
      }
    }

    try {
      const request = { ...proposal.target, values: committedValues };
      const providerResult = proposal.baseVersion.strength === "atomic"
        ? await connector.writeConditional!(request, committedBaseVersion, signal)
        : await connector.write(request, signal);
      const outcome: SpreadsheetEffectOutcome = {
        status: "committed",
        proposalId: proposal.proposalId,
        receipt: deepFreeze({
          receiptId: `receipt:${proposal.proposalId}`,
          proposalId: proposal.proposalId,
          connector: proposal.connector,
          target: { spreadsheetId: proposal.target.spreadsheetId, range: proposal.target.range },
          baseVersion: committedBaseVersion,
          preconditionStrength: proposal.baseVersion.strength,
          providerResult,
          mutations: {
            count: proposal.mutations.mutations.length,
            inverse: invertSpreadsheetMutationBundle(
              proposal.baseValues,
              proposal.mutations,
              proposal.target.inputMode
            )
          },
          committedAt: this.now().toISOString()
        })
      };
      this.attempts.set(proposal.proposalId, outcome.status);
      return outcome;
    } catch (error) {
      if (error instanceof SpreadsheetConflictError) {
        let observedVersion: SpreadsheetVersion | null = null;
        let observedValues: SpreadsheetRows | null = null;
        try {
          if (error.observedVersion) observedVersion = validateProviderVersion(error.observedVersion);
          if (error.observedValues) observedValues = cloneRows(error.observedValues);
        } catch {
          observedVersion = null;
          observedValues = null;
        }
        const outcome: SpreadsheetEffectOutcome = {
          status: "conflict",
          proposalId: proposal.proposalId,
          expectedBaseVersion: { kind: proposal.baseVersion.kind, value: proposal.baseVersion.value },
          observedBaseVersion: observedVersion,
          observedValues,
          preconditionStrength: proposal.baseVersion.strength
        };
        this.attempts.set(proposal.proposalId, outcome.status);
        return outcome;
      }
      if (error instanceof SpreadsheetWriteUncertainError) {
        const outcome: SpreadsheetEffectOutcome = {
          status: "uncertain",
          proposalId: proposal.proposalId,
          reason: error.message,
          reconciliationRequired: true
        };
        this.attempts.set(proposal.proposalId, outcome.status);
        return outcome;
      }
      const outcome = error instanceof SpreadsheetWriteRejectedError
        ? failed(proposal.proposalId, "commit", "provider_rejected_write", error.message)
        : {
            status: "uncertain" as const,
            proposalId: proposal.proposalId,
            reason: new SpreadsheetWriteUncertainError().message,
            reconciliationRequired: true as const
          };
      this.attempts.set(proposal.proposalId, outcome.status);
      return outcome;
    }
  }
}
