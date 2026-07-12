export const RUN_JOURNAL_SCHEMA_VERSION = 1 as const;
export const POLICY_DECISION_SCHEMA_VERSION = 1 as const;

export const RUN_JOURNAL_LIMITS = Object.freeze({
  maxEvents: 256,
  reservedTerminalEvents: 4,
  maxEventBytes: 16 * 1024,
  maxJournalBytes: 512 * 1024,
  maxEvidenceFields: 32
});

export type RunJournalCategory =
  | "system"
  | "source"
  | "model"
  | "tool"
  | "script"
  | "policy"
  | "proposal"
  | "approval"
  | "effect"
  | "export";

export type RunJournalOutcome =
  | "info"
  | "allowed"
  | "denied"
  | "completed"
  | "prepared"
  | "approved"
  | "rejected"
  | "committed"
  | "conflict"
  | "uncertain"
  | "failed"
  | "cancelled";

export type RunJournalEvidenceValue = string | number | boolean | null;
export type RunJournalEvidence = Readonly<Record<string, RunJournalEvidenceValue>>;

export interface PolicyDecisionEnvelope {
  readonly schemaVersion: typeof POLICY_DECISION_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly policyId: string;
  readonly capability: string;
  readonly resource: string;
  readonly decision: "stage" | "allow" | "deny";
  readonly actor: "host-policy" | "foreground-user";
  readonly reason: string;
  readonly decidedAt: string;
}

export interface RunJournalEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly elapsedMs: number;
  readonly category: RunJournalCategory;
  readonly outcome: RunJournalOutcome;
  readonly summary: string;
  readonly detail: string;
  readonly evidence: RunJournalEvidence;
}

export interface RunJournalMetrics {
  readonly elapsedMs: number;
  readonly modelEvents: number;
  readonly toolCalls: number;
  readonly scriptRuns: number;
  readonly proposalsPrepared: number;
  readonly approvals: number;
  readonly rejections: number;
  readonly commits: number;
  readonly conflicts: number;
  readonly uncertainOutcomes: number;
  readonly failures: number;
  readonly timeToFirstProposalMs: number | null;
  readonly timeToFirstCommitMs: number | null;
}

export interface RunJournal {
  readonly schemaVersion: typeof RUN_JOURNAL_SCHEMA_VERSION;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly state: "active" | "reviewed" | "committed" | "needs_attention";
  readonly events: readonly RunJournalEvent[];
  readonly metrics: RunJournalMetrics;
}

export interface RunJournalExportContext {
  task: string;
  source: {
    kind: "demo" | "artifact" | "google";
    connectorId: string | null;
    resource: string;
    sourceSha256: string | null;
  };
}

export interface RunJournalExport extends RunJournal {
  readonly context: RunJournalExportContext;
  readonly privacy: {
    readonly credentialFieldsIncluded: false;
    readonly sourceContentsIncluded: false;
    readonly defensiveRedactionApplied: true;
    readonly note: string;
  };
}

const RUN_ID_PATTERN = /^run_journal_[a-f0-9]{32}$/;
const DECISION_ID_PATTERN = /^policy_decision_[a-f0-9]{32}$/;
const EVIDENCE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_EVIDENCE_KEY = /(?:^|_)(?:api_?key|access_?token|refresh_?token|authorization|cookie|credential|password|secret)(?:_|$)/i;
const CATEGORIES = new Set<RunJournalCategory>([
  "system", "source", "model", "tool", "script", "policy", "proposal", "approval", "effect", "export"
]);
const OUTCOMES = new Set<RunJournalOutcome>([
  "info", "allowed", "denied", "completed", "prepared", "approved", "rejected", "committed",
  "conflict", "uncertain", "failed", "cancelled"
]);

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function randomHex(bytes = 16) {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Web Crypto random values are unavailable in this browser.");
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireIsoDate(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date-time.`);
  return value;
}

function requireText(value: string, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximum) throw new Error(`${label} is too long.`);
  return redactRunJournalText(normalized);
}

export function redactRunJournalText(value: string) {
  return value
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization header [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-(?:ant-|proj-|svcacct-)?|gh[pousr]_)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bya29\.[A-Za-z0-9._-]+\b/g, "[REDACTED_OAUTH_TOKEN]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sanitizeEvidence(value: Record<string, RunJournalEvidenceValue> | undefined): RunJournalEvidence {
  const source = value ?? {};
  const entries = Object.entries(source);
  if (entries.length > RUN_JOURNAL_LIMITS.maxEvidenceFields) throw new Error("Run journal event has too many evidence fields.");
  const result: Record<string, RunJournalEvidenceValue> = {};
  for (const [key, raw] of entries) {
    if (!EVIDENCE_KEY_PATTERN.test(key)) throw new Error(`Run journal evidence key ${key} is invalid.`);
    if (SECRET_EVIDENCE_KEY.test(key)) throw new Error(`Run journal evidence key ${key} may contain a credential.`);
    if (raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new Error(`Run journal evidence ${key} must be a scalar value.`);
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) throw new Error(`Run journal evidence ${key} must be finite.`);
    result[key] = typeof raw === "string" ? redactRunJournalText(raw.slice(0, 2_048)) : raw;
  }
  return deepFreeze(result);
}

function deriveMetrics(events: readonly RunJournalEvent[], elapsedMs: number): RunJournalMetrics {
  const count = (predicate: (event: RunJournalEvent) => boolean) => events.filter(predicate).length;
  const firstProposal = events.find((event) => event.category === "proposal" && event.outcome === "prepared");
  const firstCommit = events.find((event) => event.category === "effect" && event.outcome === "committed");
  return deepFreeze({
    elapsedMs,
    modelEvents: count((event) => event.category === "model"),
    toolCalls: count((event) => event.category === "tool"),
    scriptRuns: count((event) => event.category === "script" && event.outcome === "completed"),
    proposalsPrepared: count((event) => event.category === "proposal" && event.outcome === "prepared"),
    approvals: count((event) => event.category === "approval" && event.outcome === "approved"),
    rejections: count((event) => event.category === "approval" && event.outcome === "rejected"),
    commits: count((event) => event.category === "effect" && event.outcome === "committed"),
    conflicts: count((event) => event.outcome === "conflict"),
    uncertainOutcomes: count((event) => event.outcome === "uncertain"),
    failures: count((event) => event.outcome === "failed" || event.outcome === "denied"),
    timeToFirstProposalMs: firstProposal?.elapsedMs ?? null,
    timeToFirstCommitMs: firstCommit?.elapsedMs ?? null
  });
}

function deriveState(events: readonly RunJournalEvent[]): RunJournal["state"] {
  const lastTerminal = [...events].reverse().find((event) =>
    ["committed", "rejected", "conflict", "uncertain", "failed", "denied"].includes(event.outcome)
  );
  if (!lastTerminal) return "active";
  if (lastTerminal.outcome === "committed") return "committed";
  if (lastTerminal.outcome === "rejected") return "reviewed";
  return "needs_attention";
}

export function createPolicyDecisionEnvelope(input: {
  policyId: string;
  capability: string;
  resource: string;
  decision: PolicyDecisionEnvelope["decision"];
  actor: PolicyDecisionEnvelope["actor"];
  reason: string;
  decisionId?: string;
  decidedAt?: string;
}): PolicyDecisionEnvelope {
  const decisionId = input.decisionId ?? `policy_decision_${randomHex()}`;
  if (!DECISION_ID_PATTERN.test(decisionId)) throw new Error("Policy decision ID is invalid.");
  if (!(["stage", "allow", "deny"] as const).includes(input.decision)) throw new Error("Policy decision is invalid.");
  if (!(["host-policy", "foreground-user"] as const).includes(input.actor)) throw new Error("Policy actor is invalid.");
  return deepFreeze({
    schemaVersion: POLICY_DECISION_SCHEMA_VERSION,
    decisionId,
    policyId: requireText(input.policyId, "Policy ID", 128),
    capability: requireText(input.capability, "Policy capability", 128),
    resource: requireText(input.resource, "Policy resource", 1_024),
    decision: input.decision,
    actor: input.actor,
    reason: requireText(input.reason, "Policy reason", 1_024),
    decidedAt: requireIsoDate(input.decidedAt ?? new Date().toISOString(), "Policy decision time")
  });
}

export function createRunJournal(input: { runId?: string; startedAt?: string } = {}): RunJournal {
  const runId = input.runId ?? `run_journal_${randomHex()}`;
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Run journal ID is invalid.");
  const startedAt = requireIsoDate(input.startedAt ?? new Date().toISOString(), "Run journal start");
  return deepFreeze({
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
    runId,
    startedAt,
    updatedAt: startedAt,
    state: "active",
    events: [],
    metrics: deriveMetrics([], 0)
  });
}

export function appendRunJournalEvent(journal: RunJournal, input: {
  category: RunJournalCategory;
  outcome: RunJournalOutcome;
  summary: string;
  detail?: string;
  evidence?: Record<string, RunJournalEvidenceValue>;
  occurredAt?: string;
}): RunJournal {
  if (!CATEGORIES.has(input.category)) throw new Error("Run journal category is invalid.");
  if (!OUTCOMES.has(input.outcome)) throw new Error("Run journal outcome is invalid.");
  const terminal = input.category === "approval" || input.category === "effect";
  const eventLimit = RUN_JOURNAL_LIMITS.maxEvents - (terminal ? 0 : RUN_JOURNAL_LIMITS.reservedTerminalEvents);
  if (journal.events.length >= eventLimit) {
    throw new Error(terminal
      ? "Run journal event limit reached; no further review or effect can be recorded."
      : "Run journal event limit reached; terminal review/effect slots are reserved. Export and start a new run.");
  }
  const occurredAt = requireIsoDate(input.occurredAt ?? new Date().toISOString(), "Run journal event time");
  const elapsedMs = Math.max(0, Date.parse(occurredAt) - Date.parse(journal.startedAt));
  const event = deepFreeze({
    sequence: journal.events.length + 1,
    occurredAt,
    elapsedMs,
    category: input.category,
    outcome: input.outcome,
    summary: requireText(input.summary, "Run journal summary", 256),
    detail: input.detail ? redactRunJournalText(input.detail.trim()).slice(0, 4_096) : "",
    evidence: sanitizeEvidence(input.evidence)
  });
  if (byteLength(JSON.stringify(event)) > RUN_JOURNAL_LIMITS.maxEventBytes) throw new Error("Run journal event exceeds its byte limit.");
  const events = [...journal.events, event];
  const next = {
    ...journal,
    updatedAt: occurredAt,
    state: deriveState(events),
    events,
    metrics: deriveMetrics(events, elapsedMs)
  } satisfies RunJournal;
  if (byteLength(JSON.stringify(next)) > RUN_JOURNAL_LIMITS.maxJournalBytes) throw new Error("Run journal exceeds its byte limit; export and start a new run.");
  return deepFreeze(next);
}

export function buildRunJournalExport(journal: RunJournal, context: RunJournalExportContext): RunJournalExport {
  const artifact = {
    ...journal,
    context: {
      task: context.task.trim() ? redactRunJournalText(context.task.trim()).slice(0, 4_096) : "(not recorded)",
      source: {
        kind: context.source.kind,
        connectorId: context.source.connectorId ? redactRunJournalText(context.source.connectorId).slice(0, 256) : null,
        resource: redactRunJournalText(context.source.resource).slice(0, 1_024),
        sourceSha256: context.source.sourceSha256
      }
    },
    privacy: {
      credentialFieldsIncluded: false as const,
      sourceContentsIncluded: false as const,
      defensiveRedactionApplied: true as const,
      note: "Credential fields are excluded. Task text and resource identities are included after defensive pattern redaction; inspect them before sharing. Source cell and file contents are excluded."
    }
  } satisfies RunJournalExport;
  const serialized = JSON.stringify(artifact);
  if (byteLength(serialized) > RUN_JOURNAL_LIMITS.maxJournalBytes) throw new Error("Run journal export exceeds its byte limit.");
  return deepFreeze(artifact);
}

export function serializeRunJournal(journal: RunJournal, context: RunJournalExportContext) {
  return `${JSON.stringify(buildRunJournalExport(journal, context), null, 2)}\n`;
}
