import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Database,
  Download,
  FileText,
  KeyRound,
  Paperclip,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Sparkles,
  Table2,
  UploadCloud,
  X
} from "lucide-react";
import { runBusinessScriptInWorker } from "../lib/browser-script-runner";
import {
  DEFAULT_PLANNER_MODEL,
  OpenAIPlanner,
  type SpreadsheetPlan
} from "../lib/business-planner";
import {
  GoogleSheetsConnector,
  LocalSpreadsheetConnector,
  spreadsheetRowsFromBusinessValue,
  type SpreadsheetConnector,
  type SpreadsheetRows
} from "../lib/spreadsheet";
import {
  CredentialBroker,
  GOOGLE_SHEETS_MANIFEST,
  LOCAL_SPREADSHEET_MANIFEST
} from "../lib/connector";
import {
  SpreadsheetEffectExecutor,
  decideSpreadsheetEffect,
  prepareSpreadsheetEffect,
  type SpreadsheetEffectProposal
} from "../lib/spreadsheet-effect";
import { applySpreadsheetMutationBundle } from "../lib/spreadsheet-mutation";
import {
  GOOGLE_SHEETS_SCOPE,
  GoogleOAuthSession,
  type GoogleOAuthStatus
} from "../lib/google-oauth";
import { exportTabularArtifactInWorker, importTabularArtifactInWorker } from "../lib/browser-tabular-artifact";
import { runWorkspaceScriptInWorker } from "../lib/browser-workspace-script";
import {
  type TabularArtifactFormat,
  type TabularArtifactProvenance
} from "../lib/tabular-artifact-contract";
import { normalizedArtifactJson, normalizedArtifactPath, parseNormalizedArtifactJson } from "../lib/tabular-artifact-persistence";
import { googleSheetsWorkspaceSnapshotArtifact } from "../lib/google-sheets-workspace-snapshot";
import {
  listOperatorArtifacts,
  prepareOperatorArtifactAttachment,
  readOperatorArtifactPreview,
  verifyOperatorArtifactAttachment,
  type OperatorArtifactAttachment,
  type OperatorArtifactDescriptor,
  type OperatorArtifactPreview
} from "../lib/operator-artifact-browser";
import { validateWorkspaceArtifactOutputContent } from "../lib/workspace-artifact-plan";
import {
  assertWorkspaceArtifactRunInputs,
  createWorkspaceArtifactScriptDefinition,
  createWorkspaceArtifactWorkflowDraft,
  type WorkspaceArtifactWorkflowDraft
} from "../lib/workspace-artifact-workflow";
import { createOperatorWorkspaceStore, OPERATOR_WORKSPACE_ROOT } from "../lib/operator-workspace-store";
import {
  createOperatorWorkspaceBundle,
  executeOperatorWorkspaceClear,
  executeOperatorWorkspaceRestore,
  OPERATOR_WORKSPACE_BUNDLE_LIMITS,
  OperatorWorkspaceRestoreUncertainError,
  prepareOperatorWorkspaceClear,
  prepareOperatorWorkspaceRestore,
  type OperatorWorkspaceBundle,
  type OperatorWorkspaceClearProposal,
  type OperatorWorkspaceRestoreProposal
} from "../lib/operator-workspace-bundle";
import { createTabularWorkspaceScriptDefinition } from "../lib/tabular-workspace-script";
import { hashWorkspaceContent, prepareWorkspaceScriptRun } from "../lib/workspace-script";
import { serializeWorkspaceScriptManifest } from "../lib/workspace-script-contract";
import {
  decideWorkspaceFileEffect,
  executeWorkspaceFileEffect,
  prepareWorkspaceFileEffects,
  workspaceFileEffectDiff,
  type WorkspaceFileEffectProposal
} from "../lib/workspace-file-effect";
import {
  OpenAIWorkspaceAgent,
  type WorkspaceAgentBudget,
  type WorkspaceAgentTraceEvent
} from "../lib/workspace-agent";
import {
  appendRunJournalEvent,
  createPolicyDecisionEnvelope,
  createRunJournal,
  RUN_JOURNAL_LIMITS,
  serializeRunJournal,
  type RunJournal,
  type RunJournalCategory,
  type RunJournalEvidenceValue,
  type RunJournalEvent,
  type RunJournalOutcome
} from "../lib/run-journal";

const DEMO_ROWS: SpreadsheetRows = [
  ["Owner", "Region", "Amount", "Stage"],
  ["  aya tanaka", " west ", "12,400", "won"],
  ["KEN ITO  ", "East", "8300", "OPEN"],
  [" mei sato ", " north", "6,250", " Won "]
];

const DEFAULT_SCRIPT = `(rows) => rows.map((row, index) => {
  if (index === 0) return row;
  const titleCase = (value) => String(value).trim().toLowerCase()
    .replace(/(^|\\s)\\S/g, (letter) => letter.toUpperCase());
  return [
    titleCase(row[0]),
    String(row[1]).trim().toUpperCase(),
    Number(String(row[2]).replace(/,/g, "")),
    titleCase(row[3])
  ];
})`;

const EXPLICIT_APPROVAL_POLICY = "foreground-explicit-approval-v1";
const TABLE_PREVIEW_ROWS = 100;

function googleSheetsGrant(
  target: { spreadsheetId: string; range: string },
  operations: readonly ("read-range" | "write-range")[]
) {
  return {
    operations,
    pathParameters: {
      spreadsheetId: [target.spreadsheetId.trim()],
      range: [target.range.trim()]
    }
  };
}

interface AuditEntry {
  time: string;
  title: string;
  detail: string;
  tone?: "accent" | "muted";
  category?: RunJournalCategory;
  outcome?: RunJournalOutcome;
  evidence?: Record<string, RunJournalEvidenceValue>;
}

function auditEntryFromJournalEvent(event: RunJournalEvent): AuditEntry {
  const totalSeconds = Math.floor(event.elapsedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return {
    time: `${minutes}:${seconds}`,
    title: event.summary,
    detail: event.detail,
    tone: ["allowed", "completed", "prepared", "approved", "committed"].includes(event.outcome) ? "accent" : "muted",
    category: event.category,
    outcome: event.outcome,
    evidence: { ...event.evidence }
  };
}

function initialOperatorJournal() {
  return appendRunJournalEvent(createRunJournal(), {
    category: "source",
    outcome: "completed",
    summary: "Local demo loaded",
    detail: "4 rows · no external request",
    evidence: { source_kind: "demo", rows: 4 }
  });
}

function cellLabel(row: number, column: number) {
  let label = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return `${label}${row + 1}`;
}

function displayCell(value: unknown) {
  if (value === null || value === "") return "∅";
  return String(value);
}

function googleConnectionLabel(status: GoogleOAuthStatus) {
  if (status.state === "connected" && status.expiresAt) {
    return `Connected until ${new Date(status.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (status.state === "expired") return "Expired · reconnect required";
  return "Foreground OAuth session";
}

function formatArtifactBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function OperatorPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const [rows, setRows] = useState<SpreadsheetRows>(DEMO_ROWS);
  const [proposal, setProposal] = useState<SpreadsheetEffectProposal | null>(null);
  const [workspaceProposal, setWorkspaceProposal] = useState<WorkspaceFileEffectProposal | null>(null);
  const [task, setTask] = useState("Normalize names and regions, convert amounts to numbers, and standardize stages.");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [plan, setPlan] = useState<SpreadsheetPlan | null>(null);
  const [planMode, setPlanMode] = useState<"spreadsheet-transform" | "artifact-output">("spreadsheet-transform");
  const [artifactWorkflowDraft, setArtifactWorkflowDraft] = useState<WorkspaceArtifactWorkflowDraft | null>(null);
  const [plannerApiKey, setPlannerApiKey] = useState("");
  const [plannerModel, setPlannerModel] = useState(DEFAULT_PLANNER_MODEL);
  const [planning, setPlanning] = useState(false);
  const [showLocalDemoGuide, setShowLocalDemoGuide] = useState(() => (
    new URLSearchParams(window.location.search).get("demo") === "local"
  ));
  const [localDemoCompleted, setLocalDemoCompleted] = useState(false);
  const [agentTrace, setAgentTrace] = useState<WorkspaceAgentTraceEvent[]>([]);
  const [agentBudget, setAgentBudget] = useState<WorkspaceAgentBudget | null>(null);
  const [committing, setCommitting] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [source, setSource] = useState<"demo" | "artifact" | "google">("demo");
  const [artifact, setArtifact] = useState<TabularArtifactProvenance | null>(null);
  const [artifactWorkspacePath, setArtifactWorkspacePath] = useState<string | null>(null);
  const [artifactFile, setArtifactFile] = useState<File | null>(null);
  const [artifactSheetChoice, setArtifactSheetChoice] = useState("");
  const [importingArtifact, setImportingArtifact] = useState(false);
  const [exportingArtifact, setExportingArtifact] = useState(false);
  const [workspaceArchiveBusy, setWorkspaceArchiveBusy] = useState(false);
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<readonly OperatorArtifactDescriptor[]>([]);
  const [workspaceArtifactTotalBytes, setWorkspaceArtifactTotalBytes] = useState(0);
  const [workspaceArtifactBusy, setWorkspaceArtifactBusy] = useState(false);
  const [workspaceArtifactError, setWorkspaceArtifactError] = useState("");
  const [selectedWorkspaceArtifact, setSelectedWorkspaceArtifact] = useState<OperatorArtifactDescriptor | null>(null);
  const [workspaceArtifactPreview, setWorkspaceArtifactPreview] = useState<OperatorArtifactPreview | null>(null);
  const [workspaceAttachment, setWorkspaceAttachment] = useState<OperatorArtifactAttachment | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [pendingWorkspaceRestore, setPendingWorkspaceRestore] = useState<{
    fileName: string;
    bytes: Uint8Array;
    proposal: OperatorWorkspaceRestoreProposal;
  } | null>(null);
  const [pendingWorkspaceClear, setPendingWorkspaceClear] = useState<OperatorWorkspaceClearProposal | null>(null);
  const [runningWorkspaceScript, setRunningWorkspaceScript] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "");
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [revokingGoogle, setRevokingGoogle] = useState(false);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [range, setRange] = useState("Sheet1!A1:D20");
  const [loadedGoogleTarget, setLoadedGoogleTarget] = useState<{
    spreadsheetId: string;
    spreadsheetIdSha256: string;
    range: string;
  } | null>(null);
  const effectExecutor = useRef(new SpreadsheetEffectExecutor());
  const credentialBroker = useRef(new CredentialBroker());
  const googleOAuth = useRef(new GoogleOAuthSession());
  const workspace = useRef(createOperatorWorkspaceStore());
  const runJournal = useRef<RunJournal | null>(null);
  if (!runJournal.current) runJournal.current = initialOperatorJournal();
  const artifactInput = useRef<HTMLInputElement>(null);
  const workspaceBundleInput = useRef<HTMLInputElement>(null);
  const authorityEpoch = useRef(0);
  const scriptRevision = useRef(0);
  const taskRevision = useRef(0);
  const planningAbort = useRef<AbortController | null>(null);
  const [googleAuthStatus, setGoogleAuthStatus] = useState(() => googleOAuth.current.status());
  const [audit, setAudit] = useState<AuditEntry[]>(() =>
    runJournal.current ? runJournal.current.events.map(auditEntryFromJournalEvent) : []
  );

  const changes = useMemo(
    () => proposal ? proposal.mutations.mutations : [],
    [proposal]
  );
  const workspaceDiff = useMemo(
    () => workspaceProposal ? workspaceFileEffectDiff(workspaceProposal) : "",
    [workspaceProposal]
  );

  useEffect(() => {
    if (!googleAuthStatus.expiresAt) return;
    const delay = Math.max(0, Date.parse(googleAuthStatus.expiresAt) - Date.now() - 30_000);
    const timer = window.setTimeout(() => setGoogleAuthStatus(googleOAuth.current.status()), delay + 25);
    return () => window.clearTimeout(timer);
  }, [googleAuthStatus.expiresAt]);

  useEffect(() => {
    let current = true;
    setWorkspaceArtifactBusy(true);
    setWorkspaceArtifactError("");
    void listOperatorArtifacts(workspace.current).then((index) => {
      if (!current) return;
      setWorkspaceArtifacts(index.files);
      setWorkspaceArtifactTotalBytes(index.totalBytes);
      setSelectedWorkspaceArtifact((selected) => selected
        ? index.files.find((file) => file.path === selected.path && file.sha256 === selected.sha256) ?? null
        : null);
      setWorkspaceArtifactPreview((preview) => preview && index.files.some((file) =>
        file.path === preview.artifact.path && file.sha256 === preview.artifact.sha256
      ) ? preview : null);
      setWorkspaceAttachment((attachment) => attachment && index.files.some((file) =>
        file.path === attachment.path && file.sha256 === attachment.sha256
      ) ? attachment : null);
    }).catch((caught) => {
      if (!current) return;
      const message = caught instanceof Error ? caught.message : "Operator artifacts could not be indexed.";
      setWorkspaceArtifacts([]);
      setWorkspaceArtifactTotalBytes(0);
      setSelectedWorkspaceArtifact(null);
      setWorkspaceArtifactPreview(null);
      setWorkspaceAttachment(null);
      setWorkspaceArtifactError(message);
    }).finally(() => {
      if (current) setWorkspaceArtifactBusy(false);
    });
    return () => { current = false; };
  }, [workspaceRevision]);

  const record = (entry: Omit<AuditEntry, "time">) => {
    try {
      const next = appendRunJournalEvent(runJournal.current ?? initialOperatorJournal(), {
        category: entry.category ?? "system",
        outcome: entry.outcome ?? "info",
        summary: entry.title,
        detail: entry.detail,
        evidence: entry.evidence
      });
      runJournal.current = next;
      const event = next.events.at(-1)!;
      setAudit((current) => [...current, auditEntryFromJournalEvent(event)]);
      return next;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "The structured run journal could not record this event.";
      setAudit((current) => [...current, {
        time: current.at(-1)?.time ?? "00:00",
        title: "Run journal recording blocked",
        detail,
        tone: "muted"
      }]);
      return runJournal.current ?? initialOperatorJournal();
    }
  };

  const ensureJournalCapacity = (requiredEvents: number, terminal = false) => {
    const used = runJournal.current?.events.length ?? 0;
    const limit = RUN_JOURNAL_LIMITS.maxEvents - (terminal ? 0 : RUN_JOURNAL_LIMITS.reservedTerminalEvents);
    if (used + requiredEvents <= limit) return true;
    const message = terminal
      ? "This run journal has no room for the review and its terminal result. Start a fresh local run before approving."
      : "This run journal is full. Export it, then choose Local demo to start a fresh run before continuing.";
    setError(message);
    setStatus("Run journal capacity reached");
    return false;
  };

  const clearAiPlans = () => {
    setPlan(null);
    setArtifactWorkflowDraft(null);
  };

  const changePlanMode = (nextMode: "spreadsheet-transform" | "artifact-output") => {
    if (nextMode === planMode || planning || committing) return;
    planningAbort.current?.abort();
    authorityEpoch.current += 1;
    taskRevision.current += 1;
    scriptRevision.current += 1;
    invalidateProposal("AI plan mode changed");
    setPlanMode(nextMode);
    clearAiPlans();
    setAgentTrace([]);
    setAgentBudget(null);
    setScript(nextMode === "spreadsheet-transform" ? DEFAULT_SCRIPT : "");
    setStatus(nextMode === "spreadsheet-transform" ? "Table transform mode" : "Artifact output mode");
    setError("");
  };

  const invalidateProposal = (reason: string) => {
    if (proposal) {
      record({
        title: "Write proposal invalidated",
        detail: `${proposal.proposalId.slice(-12)} · ${reason}`,
        tone: "muted",
        category: "proposal",
        outcome: "cancelled",
        evidence: { proposal_id: proposal.proposalId, reason }
      });
      setProposal(null);
    }
    if (workspaceProposal) {
      record({
        title: "Workspace proposal invalidated",
        detail: `${workspaceProposal.proposalId.slice(-12)} · ${reason}`,
        tone: "muted",
        category: "proposal",
        outcome: "cancelled",
        evidence: { proposal_id: workspaceProposal.proposalId, reason }
      });
      setWorkspaceProposal(null);
    }
  };

  const refreshWorkspaceArtifacts = () => {
    setWorkspaceRevision((revision) => revision + 1);
  };

  const inspectWorkspaceArtifact = async (artifactToInspect: OperatorArtifactDescriptor) => {
    if (workspaceArtifactBusy || committing) return;
    setWorkspaceArtifactBusy(true);
    setWorkspaceArtifactError("");
    setSelectedWorkspaceArtifact(artifactToInspect);
    try {
      const preview = await readOperatorArtifactPreview(workspace.current, artifactToInspect.path);
      if (preview.artifact.sha256 !== artifactToInspect.sha256) {
        refreshWorkspaceArtifacts();
        throw new Error("The workspace artifact changed while its preview was opening. Select the refreshed file again.");
      }
      setWorkspaceArtifactPreview(preview);
      setStatus(`Previewing ${artifactToInspect.path}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Operator artifact preview failed.";
      setWorkspaceArtifactPreview(null);
      setWorkspaceArtifactError(message);
      setStatus("Workspace artifact preview blocked");
    } finally {
      setWorkspaceArtifactBusy(false);
    }
  };

  const attachWorkspaceArtifact = async () => {
    if (!selectedWorkspaceArtifact || workspaceArtifactBusy || committing) return;
    if (!ensureJournalCapacity(1)) return;
    setWorkspaceArtifactBusy(true);
    setWorkspaceArtifactError("");
    try {
      const attachment = await prepareOperatorArtifactAttachment(workspace.current, selectedWorkspaceArtifact.path);
      if (attachment.sha256 !== selectedWorkspaceArtifact.sha256) {
        refreshWorkspaceArtifacts();
        throw new Error("The workspace artifact changed after preview. Review the refreshed file before attaching it.");
      }
      planningAbort.current?.abort();
      authorityEpoch.current += 1;
      clearAiPlans();
      setWorkspaceAttachment(attachment);
      setStatus(`Attached ${attachment.path} to the next AI plan`);
      record({
        title: "Workspace artifact attached for AI review",
        detail: `${attachment.path} · ${attachment.bytes} B · ${attachment.sha256.slice(-12)} · content still local until a checkpointed tool reads it`,
        tone: "accent",
        category: "source",
        outcome: "completed",
        evidence: {
          workspace_path: attachment.path,
          source_sha256: attachment.sha256,
          source_bytes: attachment.bytes,
          media_type: attachment.mediaType,
          tabular_snapshot: attachment.tabularSnapshot
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Operator artifact attachment failed.";
      setWorkspaceAttachment(null);
      setWorkspaceArtifactError(message);
      setStatus("Workspace artifact attachment blocked");
    } finally {
      setWorkspaceArtifactBusy(false);
    }
  };

  const detachWorkspaceArtifact = () => {
    if (!workspaceAttachment) return;
    planningAbort.current?.abort();
    authorityEpoch.current += 1;
    clearAiPlans();
    const path = workspaceAttachment.path;
    setWorkspaceAttachment(null);
    setStatus(`Detached ${path} from AI planning`);
    record({
      title: "Workspace artifact detached from AI review",
      detail: `${path} · no longer in the next model-readable grant`,
      tone: "muted",
      category: "source",
      outcome: "completed",
      evidence: { workspace_path: path }
    });
  };

  const runScript = async () => {
    if (!ensureJournalCapacity(5)) return;
    invalidateProposal("sandbox transform requested again");
    setStatus("Running in Wasm worker…");
    setError("");
    const startingAuthorityEpoch = authorityEpoch.current;
    const startingScriptRevision = scriptRevision.current;
    try {
      if (source === "google" && !loadedGoogleTarget) {
        throw new Error("Read the selected Google Sheets range again before preparing a write.");
      }
      const result = await runBusinessScriptInWorker(script, rows);
      if (startingAuthorityEpoch !== authorityEpoch.current) {
        throw new Error("Google authorization changed during the transform. Read the range and run the script again.");
      }
      if (startingScriptRevision !== scriptRevision.current) {
        throw new Error("The sandbox script changed during execution. Run the current source again.");
      }
      const nextRows = spreadsheetRowsFromBusinessValue(result.output);
      const connectorManifest = source === "google" ? GOOGLE_SHEETS_MANIFEST : LOCAL_SPREADSHEET_MANIFEST;
      const effectTarget = source === "google"
        ? { ...loadedGoogleTarget!, inputMode: "RAW" as const }
        : source === "artifact" && artifact
          ? { spreadsheetId: `artifact:${artifact.sourceSha256}`, range: `${artifact.sheetName}!A1`, inputMode: "RAW" as const }
          : { spreadsheetId: "local-demo", range: "Demo!A1", inputMode: "RAW" as const };
      record({
        title: "Sandbox script completed",
        detail: `${result.inputBytes} B snapshot input · ${result.outputBytes} B transient output · no network or live OPFS`,
        tone: "accent",
        category: "script",
        outcome: "completed",
        evidence: { runtime: "quickjs-wasm-worker", input_bytes: result.inputBytes, output_bytes: result.outputBytes }
      });
      const policyDecision = createPolicyDecisionEnvelope({
        policyId: EXPLICIT_APPROVAL_POLICY,
        capability: "spreadsheet.cells.update",
        resource: `${connectorManifest.id}:${source === "google" ? loadedGoogleTarget!.spreadsheetIdSha256 : effectTarget.spreadsheetId}:${effectTarget.range}`,
        decision: "stage",
        actor: "host-policy",
        reason: "Allow an immutable proposal only; foreground approval and a current-source check remain required."
      });
      record({
        title: "Policy allowed proposal staging",
        detail: `${policyDecision.capability} · ${policyDecision.decisionId.slice(-12)} · commit authority not granted`,
        tone: "accent",
        category: "policy",
        outcome: "allowed",
        evidence: {
          decision_id: policyDecision.decisionId,
          policy_id: policyDecision.policyId,
          capability: policyDecision.capability,
          decision: policyDecision.decision
        }
      });
      const nextProposal = await prepareSpreadsheetEffect({
        connector: connectorManifest,
        target: effectTarget,
        baseValues: rows,
        values: nextRows,
        preconditionStrength: "recheck",
        policyDecisionId: policyDecision.decisionId
      });
      setProposal(nextProposal);
      setStatus(`${nextProposal.summary.changedCells} cell changes ready for review`);
      record({
        title: "Typed mutation proposal prepared",
        detail: `${nextProposal.proposalId.slice(-12)} · ${nextProposal.mutations.mutations.length} bound mutations · ${result.inputBytes} B in · ${result.outputBytes} B out · recheck required`,
        tone: "accent",
        category: "proposal",
        outcome: "prepared",
        evidence: {
          proposal_id: nextProposal.proposalId,
          policy_decision_id: policyDecision.decisionId,
          operation: nextProposal.operation,
          changed_cells: nextProposal.summary.changedCells,
          precondition_strength: nextProposal.baseVersion.strength
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sandbox transform failed.";
      setError(message);
      setStatus("Transform failed");
      record({ title: "Sandbox transform blocked", detail: message, tone: "muted", category: "script", outcome: "failed" });
    }
  };

  const draftWithAI = async () => {
    if (!ensureJournalCapacity(10)) return;
    const startingAuthorityEpoch = authorityEpoch.current;
    const startingTaskRevision = taskRevision.current;
    const startingPlanMode = planMode;
    const controller = new AbortController();
    planningAbort.current?.abort();
    planningAbort.current = controller;
    setPlanning(true);
    setStatus("Drafting a bounded AI plan…");
    setError("");
    setAgentTrace([]);
    setAgentBudget(null);
    invalidateProposal("AI plan requested");
    try {
      let nextPlan: SpreadsheetPlan | null = null;
      let nextArtifactDraft: WorkspaceArtifactWorkflowDraft | null = null;
      let usedWorkspaceTools = false;
      const preparedGrants = new Map<string, OperatorArtifactAttachment>();
      if (source === "artifact" && artifactWorkspacePath) {
        const activeArtifact = await prepareOperatorArtifactAttachment(workspace.current, artifactWorkspacePath);
        preparedGrants.set(activeArtifact.path, activeArtifact);
      }
      if (workspaceAttachment) {
        const verifiedAttachment = await verifyOperatorArtifactAttachment(workspace.current, workspaceAttachment);
        preparedGrants.set(verifiedAttachment.path, verifiedAttachment);
      }
      const grantedArtifacts = [...preparedGrants.values()];
      const googleTarget = startingPlanMode === "artifact-output" && source === "google" && loadedGoogleTarget
        ? { ...loadedGoogleTarget }
        : null;
      if (startingPlanMode === "artifact-output" && !grantedArtifacts.length && !googleTarget) {
        throw new Error("Attach a workspace artifact, import a local table, or grant the loaded Google Sheets range before drafting an artifact output.");
      }
      if (
        startingPlanMode === "artifact-output" &&
        grantedArtifacts.reduce((total, item) => total + Math.max(1, item.bytes), 0) > 512 * 1024
      ) throw new Error("Artifact workflow inputs exceed the 512 KB sandbox limit. Attach a smaller source or split the workflow.");
      if (grantedArtifacts.length || googleTarget) {
        usedWorkspaceTools = true;
        setStatus(googleTarget ? "AI may request the exact Google Sheets read grant…" : "AI is inspecting the exact workspace grant…");
        const agent = new OpenAIWorkspaceAgent(plannerApiKey, workspace.current);
        const result = await agent.plan({
          task,
          model: plannerModel,
          planKind: startingPlanMode,
          grant: {
            readablePaths: grantedArtifacts.map((item) => item.path),
            tabularPaths: grantedArtifacts.filter((item) => item.tabularSnapshot).map((item) => item.path),
            expectedSha256: Object.fromEntries(grantedArtifacts.map((item) => [item.path, item.sha256]))
          },
          googleSheetsRead: googleTarget ? {
            range: googleTarget.range,
            materialize: async (signal) => {
              if (startingAuthorityEpoch !== authorityEpoch.current) {
                throw new Error("The Google Sheets grant changed before the requested read.");
              }
              const connector = new GoogleSheetsConnector(credentialBroker.current.bind(
                GOOGLE_SHEETS_MANIFEST,
                googleOAuth.current.credentialProvider(),
                googleSheetsGrant(googleTarget, ["read-range"])
              ));
              const snapshot = await connector.read(googleTarget, signal);
              if (
                startingAuthorityEpoch !== authorityEpoch.current ||
                snapshot.spreadsheetId !== googleTarget.spreadsheetId ||
                snapshot.range !== googleTarget.range
              ) throw new Error("The Google Sheets target changed during the requested read.");
              const artifact = await googleSheetsWorkspaceSnapshotArtifact(snapshot);
              await workspace.current.writeFile(artifact.path, artifact.content);
              const attachment = await prepareOperatorArtifactAttachment(workspace.current, artifact.path);
              if (attachment.sha256 !== artifact.sha256 || attachment.bytes !== artifact.bytes) {
                throw new Error("The Google Sheets workspace snapshot changed during materialization.");
              }
              refreshWorkspaceArtifacts();
              record({
                title: "Google Sheets AI read snapshot materialized",
                detail: `${snapshot.range} · ${snapshot.values.length} rows · ${attachment.path} · ${attachment.sha256.slice(-12)} · credential and provider resource ID excluded`,
                tone: "accent",
                category: "source",
                outcome: "completed",
                evidence: {
                  connector_id: GOOGLE_SHEETS_MANIFEST.id,
                  connector_version: GOOGLE_SHEETS_MANIFEST.version,
                  range: snapshot.range,
                  rows: snapshot.values.length,
                  columns: snapshot.values.reduce((maximum, row) => Math.max(maximum, row.length), 0),
                  workspace_path: attachment.path,
                  source_sha256: attachment.sha256,
                  source_bytes: attachment.bytes
                }
              });
              return attachment;
            }
          } : undefined,
          inputRows: rows.length,
          inputCells: rows.reduce((total, row) => total + row.length, 0),
          signal: controller.signal,
          onTrace: (event, budget) => {
            setAgentTrace((current) => [...current, event]);
            setAgentBudget(budget);
            record({
              title: event.status === "denied" ? `AI tool denied: ${event.tool}` : `AI tool: ${event.tool}`,
              detail: `${event.summary}${event.path ? ` · ${event.path}` : ""}${event.sourceSha256 ? ` · ${event.sourceSha256.slice(-12)}` : ""} · ${event.bytesToModel} B to model`,
              tone: event.status === "denied" ? "muted" : "accent",
              category: "tool",
              outcome: event.status === "denied" ? "denied" : "completed",
              evidence: {
                tool: event.tool,
                call_id: event.callId,
                path: event.path ?? null,
                source_sha256: event.sourceSha256 ?? null,
                bytes_to_model: event.bytesToModel,
                model_requests: budget.modelRequests,
                tool_calls: budget.toolCalls,
                cumulative_egress_bytes: budget.egressBytes
              }
            });
          }
        });
        if (startingPlanMode === "artifact-output") {
          if (result.plan.kind !== "artifact-output") throw new Error("Workspace agent returned the wrong plan type.");
          nextArtifactDraft = createWorkspaceArtifactWorkflowDraft(result.plan, [
            ...grantedArtifacts,
            ...result.materializedArtifacts
          ]);
        } else {
          if (result.plan.kind !== "spreadsheet-transform") throw new Error("Workspace agent returned the wrong plan type.");
          nextPlan = result.plan;
        }
        setAgentTrace([...result.trace]);
        setAgentBudget(result.budget);
        record({
          title: "Checkpointed workspace plan staged",
          detail: `${result.grantedPaths.length} identity-bound files · ${result.budget.modelRequests} model requests · ${result.budget.toolCalls} tool calls · ${result.budget.egressBytes} B tool egress · no script execution or external write`,
          tone: "accent",
          category: "model",
          outcome: "prepared",
          evidence: {
            model_requests: result.budget.modelRequests,
            tool_calls: result.budget.toolCalls,
            egress_bytes: result.budget.egressBytes,
            granted_files: result.grantedPaths.length,
            materialized_connector_snapshots: result.materializedArtifacts.length
          }
        });
      } else {
        if (startingPlanMode !== "spreadsheet-transform") throw new Error("Artifact output planning requires an exact workspace or connector input.");
        const planner = new OpenAIPlanner(plannerApiKey);
        nextPlan = await planner.planSpreadsheetTransform({ task, rows, model: plannerModel }, controller.signal);
      }
      if (
        startingAuthorityEpoch !== authorityEpoch.current ||
        startingTaskRevision !== taskRevision.current ||
        startingPlanMode !== planMode
      ) {
        throw new Error("The task or granted source changed during AI planning. Start a new plan against the current state.");
      }
      if (!nextPlan && !nextArtifactDraft) throw new Error("AI planning returned no staged plan.");
      setPlan(nextPlan);
      setArtifactWorkflowDraft(nextArtifactDraft);
      scriptRevision.current += 1;
      setScript(nextArtifactDraft?.plan.script ?? nextPlan!.script);
      setStatus(nextArtifactDraft ? "Artifact workflow staged for review" : "AI plan staged for review");
      const stagedPlan = nextArtifactDraft?.plan ?? nextPlan!;
      record({
        title: nextArtifactDraft ? "AI artifact workflow staged" : "AI plan staged",
        detail: usedWorkspaceTools
          ? `${stagedPlan.model} · checkpointed workspace egress recorded above · no credential, execution, or write`
          : `${nextPlan!.model} · ${nextPlan!.inputRows} rows / ${nextPlan!.inputCells} cells sent · no credential or write`,
        tone: "accent",
        category: "model",
        outcome: "prepared",
        evidence: {
          model: stagedPlan.model,
          plan_kind: stagedPlan.kind,
          checkpointed_tools: usedWorkspaceTools,
          input_rows: nextPlan?.inputRows ?? 0,
          input_cells: nextPlan?.inputCells ?? 0,
          input_files: nextArtifactDraft?.inputs.length ?? 0,
          output_path: nextArtifactDraft?.plan.outputPath ?? null,
          output_media_type: nextArtifactDraft?.plan.outputMediaType ?? null
        }
      });
    } catch (caught) {
      const aborted = caught instanceof Error && caught.name === "AbortError";
      const message = aborted ? "AI planning was cancelled before a proposal was staged." : caught instanceof Error ? caught.message : "AI planning failed.";
      if (message.includes("after attachment review")) {
        setWorkspaceAttachment(null);
        refreshWorkspaceArtifacts();
      }
      clearAiPlans();
      if (aborted && startingAuthorityEpoch !== authorityEpoch.current) {
        record({ title: "AI planning cancelled", detail: "A newer source replaced the granted planning context.", tone: "muted", category: "model", outcome: "cancelled" });
        return;
      }
      setError(aborted ? "" : message);
      setStatus(aborted ? "AI planning cancelled" : "AI plan blocked");
      record({ title: aborted ? "AI planning cancelled" : "AI plan blocked", detail: message, tone: "muted", category: "model", outcome: aborted ? "cancelled" : "failed" });
    } finally {
      if (planningAbort.current === controller) planningAbort.current = null;
      setPlanning(false);
    }
  };

  const cancelPlanning = () => {
    planningAbort.current?.abort();
    setStatus("Cancelling AI planning…");
  };

  const connectGoogle = async () => {
    if (connectingGoogle || revokingGoogle) return;
    if (!ensureJournalCapacity(3)) return;
    setConnectingGoogle(true);
    setError("");
    setStatus("Opening Google authorization…");
    authorityEpoch.current += 1;
    invalidateProposal("Google authorization requested");
    setLoadedGoogleTarget(null);
    try {
      const nextStatus = await googleOAuth.current.authorize(googleClientId, [GOOGLE_SHEETS_SCOPE]);
      setGoogleAuthStatus(nextStatus);
      setStatus("Google Sheets connected — read a range to continue");
      record({
        title: "Google Sheets authorized",
        detail: `Foreground token · Sheets read/write scope · expires ${new Date(nextStatus.expiresAt!).toLocaleTimeString()} · credential not logged`,
        tone: "accent",
        category: "policy",
        outcome: "allowed",
        evidence: { connector_id: GOOGLE_SHEETS_MANIFEST.id, auth_mode: "foreground-oauth", persisted: false }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google authorization failed.";
      setGoogleAuthStatus(googleOAuth.current.status());
      setError(message);
      setStatus("Google authorization not completed");
      record({ title: "Google authorization blocked", detail: message, tone: "muted", category: "policy", outcome: "denied" });
    } finally {
      setConnectingGoogle(false);
    }
  };

  const revokeGoogle = async () => {
    if (connectingGoogle || revokingGoogle) return;
    if (!ensureJournalCapacity(3)) return;
    planningAbort.current?.abort();
    setRevokingGoogle(true);
    setError("");
    setStatus("Revoking Google access…");
    authorityEpoch.current += 1;
    invalidateProposal("Google access revoked");
    setLoadedGoogleTarget(null);
    clearAiPlans();
    setRows(DEMO_ROWS);
    setArtifact(null);
    setArtifactWorkspacePath(null);
    setArtifactFile(null);
    setArtifactSheetChoice("");
    setSource("demo");
    try {
      setGoogleAuthStatus(await googleOAuth.current.revoke());
      setStatus("Google access revoked; local demo restored");
      record({ title: "Google access revoked", detail: "Session token cleared before revocation · local demo restored", tone: "muted", category: "policy", outcome: "completed", evidence: { connector_id: GOOGLE_SHEETS_MANIFEST.id } });
    } catch (caught) {
      setGoogleAuthStatus(googleOAuth.current.status());
      const message = caught instanceof Error ? caught.message : "Google access revocation failed.";
      setError(message);
      setStatus("Local credential cleared; verify Google Account permissions");
      record({ title: "Google revocation unconfirmed", detail: message, tone: "muted", category: "policy", outcome: "uncertain", evidence: { connector_id: GOOGLE_SHEETS_MANIFEST.id } });
    } finally {
      setRevokingGoogle(false);
    }
  };

  const loadGoogleSheet = async () => {
    if (connectingGoogle || revokingGoogle) return;
    if (!ensureJournalCapacity(3)) return;
    planningAbort.current?.abort();
    const startingAuthorityEpoch = authorityEpoch.current;
    setStatus("Reading Google Sheets…");
    setError("");
    try {
      const connector = new GoogleSheetsConnector(credentialBroker.current.bind(
        GOOGLE_SHEETS_MANIFEST,
        googleOAuth.current.credentialProvider(),
        googleSheetsGrant({ spreadsheetId, range }, ["read-range"])
      ));
      const snapshot = await connector.read({ spreadsheetId, range });
      if (startingAuthorityEpoch !== authorityEpoch.current) {
        throw new Error("Google authorization changed during the range read. Read the range again.");
      }
      invalidateProposal("source range replaced by a fresh read");
      setRows(snapshot.values);
      clearAiPlans();
      setArtifact(null);
      setArtifactWorkspacePath(null);
      setArtifactFile(null);
      setArtifactSheetChoice("");
      setSource("google");
      setLoadedGoogleTarget({
        spreadsheetId: snapshot.spreadsheetId,
        spreadsheetIdSha256: await hashWorkspaceContent(snapshot.spreadsheetId),
        range: snapshot.range
      });
      setSpreadsheetId(snapshot.spreadsheetId);
      setRange(snapshot.range);
      setStatus(`Loaded ${snapshot.values.length} rows from ${snapshot.range}`);
      record({
        title: "Google Sheets range read",
        detail: `${snapshot.range} · ${snapshot.values.length} rows · broker attached credential after manifest validation · provider resource ID not logged`,
        tone: "accent",
        category: "source",
        outcome: "completed",
        evidence: {
          connector_id: GOOGLE_SHEETS_MANIFEST.id,
          target_bound: true,
          range: snapshot.range,
          rows: snapshot.values.length,
          columns: snapshot.values.reduce((maximum, row) => Math.max(maximum, row.length), 0)
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets read failed.";
      if (/authorization|reconnect/i.test(message)) {
        googleOAuth.current.clear();
        setGoogleAuthStatus(googleOAuth.current.status());
      }
      setError(message);
      setStatus("Connector read failed");
      record({ title: "Connector read blocked", detail: message, tone: "muted", category: "source", outcome: "failed", evidence: { connector_id: GOOGLE_SHEETS_MANIFEST.id } });
    }
  };

  const approveWrite = async () => {
    if (!proposal || committing || connectingGoogle || revokingGoogle) return;
    if (!ensureJournalCapacity(2, true)) return;
    setCommitting(true);
    setError("");
    try {
      const isGoogle = proposal.connector.id === GOOGLE_SHEETS_MANIFEST.id;
      setStatus(isGoogle ? "Rechecking source before the approved write…" : "Validating the approved local effect…");
      const connector: SpreadsheetConnector = isGoogle
        ? new GoogleSheetsConnector(credentialBroker.current.bind(
            GOOGLE_SHEETS_MANIFEST,
            googleOAuth.current.credentialProvider(),
            googleSheetsGrant(proposal.target, ["read-range", "write-range"])
          ))
        : new LocalSpreadsheetConnector({
            target: proposal.target,
            readValues: () => rows.map((row) => [...row]),
            writeValues: (values) => setRows(values.map((row) => [...row]))
          });
      const approval = decideSpreadsheetEffect(proposal, "approve", "foreground-user");
      record({
        title: "Spreadsheet proposal approved",
        detail: `${proposal.proposalId.slice(-12)} · exact proposal only · source recheck still required`,
        tone: "accent",
        category: "approval",
        outcome: "approved",
        evidence: { proposal_id: proposal.proposalId, actor: approval.actor, decision: approval.decision }
      });
      const outcome = await effectExecutor.current.execute(proposal, approval, connector);

      if (outcome.status === "committed") {
        setRows(applySpreadsheetMutationBundle(
          proposal.baseValues,
          proposal.mutations,
          proposal.target.inputMode
        ));
        setProposal(null);
        clearAiPlans();
        setStatus(isGoogle
          ? `Updated ${outcome.receipt.providerResult.updatedCells} cells in ${outcome.receipt.providerResult.updatedRange}`
          : source === "artifact" ? "Approved changes applied to the imported working snapshot" : "Approved changes applied to the local demo");
        if (source === "demo") setLocalDemoCompleted(true);
        record({
          title: isGoogle ? "Google Sheets effect committed" : "Local effect committed",
          detail: `${outcome.receipt.receiptId.slice(-12)} · ${proposal.summary.changedCells} cells · ${outcome.receipt.preconditionStrength}`,
          tone: "accent",
          category: "effect",
          outcome: "committed",
          evidence: {
            proposal_id: proposal.proposalId,
            receipt_id: outcome.receipt.receiptId,
            connector_id: outcome.receipt.connector.id,
            changed_cells: proposal.summary.changedCells,
            precondition_strength: outcome.receipt.preconditionStrength
          }
        });
      } else if (outcome.status === "conflict") {
        if (outcome.observedValues) setRows(outcome.observedValues);
        else setLoadedGoogleTarget(null);
        setProposal(null);
        clearAiPlans();
        setStatus("Write blocked by source conflict");
        setError("The source changed after this proposal was prepared. Review the latest values and prepare a new proposal.");
        record({
          title: "Write blocked: source conflict",
          detail: `${outcome.preconditionStrength} · expected ${outcome.expectedBaseVersion.value.slice(-10)} · observed ${outcome.observedBaseVersion?.value.slice(-10) ?? "provider conflict"}`,
          tone: "muted",
          category: "effect",
          outcome: "conflict",
          evidence: { proposal_id: proposal.proposalId, precondition_strength: outcome.preconditionStrength }
        });
      } else if (outcome.status === "uncertain") {
        setProposal(null);
        setLoadedGoogleTarget(null);
        setStatus("Write outcome uncertain — reconciliation required");
        setError(outcome.reason);
        record({ title: "Write outcome uncertain", detail: "No automatic retry · read the target before another proposal", tone: "muted", category: "effect", outcome: "uncertain", evidence: { proposal_id: proposal.proposalId, reconciliation_required: true } });
      } else if (outcome.status === "failed") {
        if (outcome.code === "source_recheck_failed" && /authorization|reconnect/i.test(outcome.reason)) {
          googleOAuth.current.clear();
          setGoogleAuthStatus(googleOAuth.current.status());
        }
        if (!outcome.retryable) setProposal(null);
        setStatus(outcome.retryable ? "Source recheck failed — safe to retry" : "Approved write blocked");
        setError(outcome.reason);
        record({ title: "Approved effect blocked", detail: `${outcome.code} · ${outcome.reason}`, tone: "muted", category: "effect", outcome: "failed", evidence: { proposal_id: proposal.proposalId, code: outcome.code, retryable: outcome.retryable } });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets write failed.";
      setError(message);
      setStatus("Approved effect blocked");
      record({ title: "Approved effect blocked", detail: message, tone: "muted", category: "effect", outcome: "failed", evidence: { proposal_id: proposal.proposalId } });
    } finally {
      setCommitting(false);
    }
  };

  const rejectWrite = async () => {
    if (!proposal || committing) return;
    if (!ensureJournalCapacity(1, true)) return;
    const rejection = decideSpreadsheetEffect(proposal, "reject", "foreground-user");
    const outcome = await effectExecutor.current.reject(proposal, rejection);
    if (outcome.status === "rejected") {
      record({
        title: "Write proposal rejected",
        detail: `${proposal.proposalId.slice(-12)} · no mutation occurred`,
        tone: "muted",
        category: "approval",
        outcome: "rejected",
        evidence: { proposal_id: proposal.proposalId, actor: rejection.actor, decision: rejection.decision }
      });
      setProposal(null);
      setStatus("Write proposal rejected; no mutation occurred");
    } else if (outcome.status === "failed") {
      setError(outcome.reason);
      setStatus("Proposal rejection could not be recorded");
    }
  };

  const runWorkspaceOutput = async () => {
    const artifactDraft = artifactWorkflowDraft;
    const tabularReady = Boolean(artifact && artifactWorkspacePath);
    if ((!artifactDraft && !tabularReady) || runningWorkspaceScript || committing) return;
    if (!ensureJournalCapacity(6)) return;
    invalidateProposal("workspace script requested");
    setRunningWorkspaceScript(true);
    setError("");
    setStatus("Saving a manifest-bound workspace script…");
    const startingAuthorityEpoch = authorityEpoch.current;
    const startingScriptRevision = scriptRevision.current;
    try {
      if (artifactDraft) {
        for (const input of artifactDraft.inputs) await verifyOperatorArtifactAttachment(workspace.current, input);
      }
      const definition = artifactDraft
        ? createWorkspaceArtifactScriptDefinition(artifactDraft, script)
        : createTabularWorkspaceScriptDefinition({
            provenance: artifact!,
            inputPath: artifactWorkspacePath!,
            transformSource: script
          });
      await workspace.current.writeFile(definition.manifest.sourcePath, definition.source);
      await workspace.current.writeFile(
        definition.manifestPath,
        serializeWorkspaceScriptManifest(definition.manifest)
      );
      refreshWorkspaceArtifacts();
      if (
        startingAuthorityEpoch !== authorityEpoch.current ||
        startingScriptRevision !== scriptRevision.current
      ) {
        throw new Error("The source artifact or script changed while the workspace definition was saved.");
      }
      record({
        title: artifactDraft ? "Artifact workflow definition saved" : "Workspace script definition saved",
        detail: `${definition.manifest.sourcePath} · ${definition.manifestPath} · ${definition.manifest.inputs.length} exact input grant${definition.manifest.inputs.length === 1 ? "" : "s"} · 1 exact output grant`,
        tone: "accent",
        category: "script",
        outcome: "prepared",
        evidence: {
          script_id: definition.manifest.id,
          script_version: definition.manifest.version,
          source_path: definition.manifest.sourcePath,
          manifest_path: definition.manifestPath,
          input_grants: definition.manifest.inputs.length,
          output_grants: definition.manifest.outputs.length
        }
      });
      setStatus("Running against the granted input snapshot…");
      const snapshot = await prepareWorkspaceScriptRun(workspace.current, definition.manifest);
      if (artifactDraft) assertWorkspaceArtifactRunInputs(snapshot, artifactDraft);
      const execution = await runWorkspaceScriptInWorker(snapshot);
      if (
        startingAuthorityEpoch !== authorityEpoch.current ||
        startingScriptRevision !== scriptRevision.current
      ) {
        throw new Error("The source artifact or script changed during workspace execution.");
      }
      if (artifactDraft) {
        if (execution.outputs.length !== 1) throw new Error("Artifact workflow must produce exactly one declared output.");
        await validateWorkspaceArtifactOutputContent(execution.outputs[0].mediaType, execution.outputs[0].content);
      }
      record({
        title: artifactDraft ? "Artifact workflow script completed" : "Workspace script completed",
        detail: `${snapshot.runId.slice(-12)} · ${execution.inputBytes} B snapshot input · ${execution.outputBytes} B transient output · no live OPFS mount`,
        tone: "accent",
        category: "script",
        outcome: "completed",
        evidence: {
          script_run_id: snapshot.runId,
          script_id: snapshot.manifest.id,
          input_bytes: execution.inputBytes,
          output_bytes: execution.outputBytes
        }
      });
      const policyDecision = createPolicyDecisionEnvelope({
        policyId: EXPLICIT_APPROVAL_POLICY,
        capability: "workspace.file.write",
        resource: snapshot.outputBases.map((base) => base.workspacePath).join(","),
        decision: "stage",
        actor: "host-policy",
        reason: "Allow file-diff proposals only; live workspace writes require a separate foreground approval and dependency recheck."
      });
      record({
        title: "Policy allowed file proposal staging",
        detail: `${policyDecision.decisionId.slice(-12)} · ${snapshot.outputBases.length} exact output grant · commit authority not granted`,
        tone: "accent",
        category: "policy",
        outcome: "allowed",
        evidence: {
          decision_id: policyDecision.decisionId,
          policy_id: policyDecision.policyId,
          capability: policyDecision.capability,
          output_grants: snapshot.outputBases.length
        }
      });
      const proposals = await prepareWorkspaceFileEffects(
        snapshot,
        execution,
        policyDecision.decisionId
      );
      if (!proposals.length) {
        setStatus("Workspace script completed with no file changes");
        record({
          title: "Workspace run produced no file effect",
          detail: `${snapshot.runId.slice(-12)} · ${execution.inputBytes} B in · ${execution.outputBytes} B transient output`,
          tone: "muted",
          category: "effect",
          outcome: "completed",
          evidence: { script_run_id: snapshot.runId, changed_files: 0 }
        });
        return;
      }
      setWorkspaceProposal(proposals[0]);
      setStatus(`Workspace output ready for review: ${proposals[0].target.workspacePath}`);
      record({
        title: "Workspace file proposal prepared",
        detail: `${snapshot.runId.slice(-12)} · ${proposals[0].proposalId.slice(-12)} · ${execution.inputBytes} B in · ${execution.outputBytes} B out · live OPFS was not mounted`,
        tone: "accent",
        category: "proposal",
        outcome: "prepared",
        evidence: {
          proposal_id: proposals[0].proposalId,
          policy_decision_id: policyDecision.decisionId,
          script_run_id: snapshot.runId,
          workspace_path: proposals[0].target.workspacePath,
          output_bytes: proposals[0].output.bytes,
          precondition_strength: "recheck"
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Workspace script failed.";
      setError(message);
      setStatus("Workspace script blocked");
      record({ title: "Workspace script blocked", detail: message, tone: "muted", category: "script", outcome: "failed" });
    } finally {
      setRunningWorkspaceScript(false);
    }
  };

  const approveWorkspaceFile = async () => {
    if (!workspaceProposal || committing) return;
    if (!ensureJournalCapacity(2, true)) return;
    setCommitting(true);
    setError("");
    setStatus("Rechecking the workspace script dependencies and output base…");
    try {
      const approval = decideWorkspaceFileEffect(workspaceProposal, "approve", "foreground-user");
      record({
        title: "Workspace file proposal approved",
        detail: `${workspaceProposal.proposalId.slice(-12)} · exact proposal only · dependency and output-base recheck still required`,
        tone: "accent",
        category: "approval",
        outcome: "approved",
        evidence: { proposal_id: workspaceProposal.proposalId, actor: approval.reviewerId, decision: approval.decision }
      });
      const outcome = await executeWorkspaceFileEffect(
        workspaceProposal,
        approval,
        workspace.current
      );
      if (outcome.status === "committed") {
        setWorkspaceProposal(null);
        refreshWorkspaceArtifacts();
        setStatus(`Saved ${outcome.receipt.workspacePath}`);
        record({
          title: "Workspace file effect committed",
          detail: `${outcome.receipt.receiptId.slice(-12)} · ${outcome.receipt.workspacePath} · ${outcome.receipt.bytes} B · recheck`,
          tone: "accent",
          category: "effect",
          outcome: "committed",
          evidence: {
            proposal_id: workspaceProposal.proposalId,
            receipt_id: outcome.receipt.receiptId,
            workspace_path: outcome.receipt.workspacePath,
            bytes: outcome.receipt.bytes,
            precondition_strength: outcome.receipt.preconditionStrength
          }
        });
      } else if (outcome.status === "conflict") {
        setWorkspaceProposal(null);
        refreshWorkspaceArtifacts();
        setStatus("Workspace write blocked by source conflict");
        setError(`${outcome.resourcePath} changed after this proposal was prepared. Run the workspace script again against current workspace state.`);
        record({
          title: "Workspace write blocked: conflict",
          detail: `${outcome.resourcePath} · expected ${outcome.expectedSha256.slice(-12)} · observed ${outcome.observedSha256.slice(-12)}`,
          tone: "muted",
          category: "effect",
          outcome: "conflict",
          evidence: { proposal_id: workspaceProposal.proposalId, resource_path: outcome.resourcePath }
        });
      } else if (outcome.status === "uncertain") {
        setWorkspaceProposal(null);
        refreshWorkspaceArtifacts();
        setStatus("Workspace write outcome uncertain — reconciliation required");
        setError(outcome.reason);
        record({ title: "Workspace write outcome uncertain", detail: outcome.reason, tone: "muted", category: "effect", outcome: "uncertain", evidence: { proposal_id: workspaceProposal.proposalId, reconciliation_required: true } });
      } else if (outcome.status === "failed") {
        if (!outcome.retryable) setWorkspaceProposal(null);
        setStatus(outcome.retryable ? "Workspace validation failed — safe to retry" : "Workspace effect blocked");
        setError(outcome.reason);
        record({ title: "Workspace effect blocked", detail: outcome.reason, tone: "muted", category: "effect", outcome: "failed", evidence: { proposal_id: workspaceProposal.proposalId, retryable: outcome.retryable } });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Workspace effect execution failed.";
      setWorkspaceProposal(null);
      setStatus("Workspace effect outcome requires reconciliation");
      setError(message);
      record({ title: "Workspace effect execution failed", detail: message, tone: "muted", category: "effect", outcome: "uncertain", evidence: { proposal_id: workspaceProposal.proposalId, reconciliation_required: true } });
    } finally {
      setCommitting(false);
    }
  };

  const rejectWorkspaceFile = async () => {
    if (!workspaceProposal || committing) return;
    if (!ensureJournalCapacity(1, true)) return;
    const rejection = decideWorkspaceFileEffect(workspaceProposal, "reject", "foreground-user");
    const outcome = await executeWorkspaceFileEffect(
      workspaceProposal,
      rejection,
      workspace.current
    );
    if (outcome.status === "rejected") {
      record({
        title: "Workspace file proposal rejected",
        detail: `${workspaceProposal.proposalId.slice(-12)} · no output was written`,
        tone: "muted",
        category: "approval",
        outcome: "rejected",
        evidence: { proposal_id: workspaceProposal.proposalId, actor: rejection.reviewerId, decision: rejection.decision }
      });
      setWorkspaceProposal(null);
      setStatus("Workspace file proposal rejected; no output was written");
    } else if (outcome.status === "failed") {
      setError(outcome.reason);
      setStatus("Workspace proposal rejection could not be recorded");
    }
  };

  const resetDemo = () => {
    planningAbort.current?.abort();
    authorityEpoch.current += 1;
    setRows(DEMO_ROWS);
    setProposal(null);
    setWorkspaceProposal(null);
    clearAiPlans();
    setPlanMode("spreadsheet-transform");
    scriptRevision.current += 1;
    setScript(DEFAULT_SCRIPT);
    setAgentTrace([]);
    setAgentBudget(null);
    setWorkspaceAttachment(null);
    setArtifact(null);
    setArtifactWorkspacePath(null);
    setArtifactFile(null);
    setArtifactSheetChoice("");
    setSource("demo");
    setShowLocalDemoGuide(true);
    setLocalDemoCompleted(false);
    setLoadedGoogleTarget(null);
    setStatus("Ready");
    setError("");
    const nextJournal = initialOperatorJournal();
    runJournal.current = nextJournal;
    setAudit(nextJournal.events.map(auditEntryFromJournalEvent));
  };

  const importLocalArtifact = async (file: File, sheetName?: string) => {
    if (!ensureJournalCapacity(4)) {
      if (artifactInput.current) artifactInput.current.value = "";
      return;
    }
    planningAbort.current?.abort();
    const importEpoch = authorityEpoch.current + 1;
    authorityEpoch.current = importEpoch;
    setImportingArtifact(true);
    setError("");
    setStatus(`Validating ${file.name} in an import worker…`);
    invalidateProposal("local artifact import requested");
    setLoadedGoogleTarget(null);
    try {
      const snapshot = await importTabularArtifactInWorker(file, sheetName);
      if (authorityEpoch.current !== importEpoch) throw new Error("A newer source replaced this import.");
      const path = normalizedArtifactPath(snapshot);
      let persistedPath: string | null = null;
      let persistenceWarning = "";
      try {
        await workspace.current.writeFile(path, normalizedArtifactJson(snapshot));
        persistedPath = path;
        refreshWorkspaceArtifacts();
      } catch {
        persistenceWarning = " · OPFS persistence failed; export before closing this tab";
      }
      setRows(snapshot.rows.map((row) => [...row]));
      setArtifact(snapshot.provenance);
      setArtifactWorkspacePath(persistedPath);
      setArtifactFile(file);
      setArtifactSheetChoice(snapshot.provenance.sheetName);
      clearAiPlans();
      setAgentTrace([]);
      setAgentBudget(null);
      setSource("artifact");
      setStatus(`Loaded ${snapshot.provenance.rows} rows from ${snapshot.provenance.sheetName}`);
      record({
        title: "Local tabular artifact imported",
        detail: `${snapshot.provenance.sourceName} · ${snapshot.provenance.format.toUpperCase()} · ${snapshot.provenance.rows}×${snapshot.provenance.columns} · sha256 ${snapshot.provenance.sourceSha256.slice(0, 12)} · ${persistedPath ?? "memory only"}${persistenceWarning}`,
        tone: "accent",
        category: "source",
        outcome: "completed",
        evidence: {
          source_kind: "artifact",
          format: snapshot.provenance.format,
          source_name: snapshot.provenance.sourceName,
          source_sha256: snapshot.provenance.sourceSha256,
          source_bytes: snapshot.provenance.sourceBytes,
          rows: snapshot.provenance.rows,
          columns: snapshot.provenance.columns,
          workspace_path: persistedPath
        }
      });
      if (snapshot.provenance.warnings.length) {
        record({
          title: "Value-only import boundary",
          detail: snapshot.provenance.warnings.join(" "),
          tone: "muted",
          category: "source",
          outcome: "info",
          evidence: { warning_count: snapshot.provenance.warnings.length }
        });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Local tabular artifact import failed.";
      setError(message);
      setStatus("Local artifact import blocked");
      record({ title: "Local artifact import blocked", detail: message, tone: "muted", category: "source", outcome: "failed", evidence: { source_name: file.name } });
    } finally {
      setImportingArtifact(false);
      if (artifactInput.current) artifactInput.current.value = "";
    }
  };

  const exportWorkingData = async (format: TabularArtifactFormat) => {
    if (exportingArtifact) return;
    if (!ensureJournalCapacity(1)) return;
    setExportingArtifact(true);
    setError("");
    try {
      const baseName = artifact?.sourceName ?? (source === "google" ? "google-sheets-result" : "wasmhatch-demo");
      const exported = await exportTabularArtifactInWorker(rows, format, baseName);
      const bytes = new Uint8Array(exported.bytes.byteLength);
      bytes.set(exported.bytes);
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: exported.mediaType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Exported ${exported.fileName}`);
      record({
        title: "Value-only artifact exported",
        detail: `${exported.fileName} · ${rows.length} rows · ${exported.bytes.byteLength} B${exported.neutralizedFormulaCells ? ` · ${exported.neutralizedFormulaCells} CSV formula prefixes neutralized` : ""}`,
        tone: "accent",
        category: "export",
        outcome: "completed",
        evidence: {
          format,
          file_name: exported.fileName,
          rows: rows.length,
          bytes: exported.bytes.byteLength,
          neutralized_formula_cells: exported.neutralizedFormulaCells
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Artifact export failed.";
      setError(message);
      setStatus("Artifact export blocked");
      record({ title: "Artifact export blocked", detail: message, tone: "muted", category: "export", outcome: "failed", evidence: { format } });
    } finally {
      setExportingArtifact(false);
    }
  };

  const adoptRestoredWorkspace = (bundle: OperatorWorkspaceBundle) => {
    const activePath = bundle.manifest.activeArtifactPath;
    if (activePath) {
      const activeFile = bundle.files.find((file) => file.path === activePath);
      if (!activeFile) throw new Error("Restored workspace is missing its active artifact.");
      const snapshot = parseNormalizedArtifactJson(activeFile.content);
      setRows(snapshot.rows.map((row) => [...row]));
      setArtifact(snapshot.provenance);
      setArtifactWorkspacePath(activePath);
      setArtifactSheetChoice(snapshot.provenance.sheetName);
      setSource("artifact");
    } else {
      setRows(DEMO_ROWS);
      setArtifact(null);
      setArtifactWorkspacePath(null);
      setArtifactSheetChoice("");
      setSource("demo");
    }
    setArtifactFile(null);
    setLoadedGoogleTarget(null);
    clearAiPlans();
    setAgentTrace([]);
    setAgentBudget(null);
    setWorkspaceAttachment(null);
    setSelectedWorkspaceArtifact(null);
    setWorkspaceArtifactPreview(null);
    refreshWorkspaceArtifacts();
    setPlanMode("spreadsheet-transform");
    scriptRevision.current += 1;
    setScript(DEFAULT_SCRIPT);
  };

  const exportOperatorWorkspace = async () => {
    if (workspaceArchiveBusy || committing) return;
    if (!ensureJournalCapacity(1)) return;
    setWorkspaceArchiveBusy(true);
    setError("");
    try {
      const exported = await createOperatorWorkspaceBundle(workspace.current, {
        activeArtifactPath: source === "artifact" ? artifactWorkspacePath : null
      });
      const copy = new Uint8Array(exported.bytes.byteLength);
      copy.set(exported.bytes);
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Exported ${exported.manifest.files.length} workspace files`);
      record({
        title: "Operator workspace exported",
        detail: `${exported.fileName} · ${exported.manifest.files.length} files · ${exported.manifest.totalBytes} B text · ${exported.bytes.byteLength} B ZIP`,
        tone: "accent",
        category: "export",
        outcome: "completed",
        evidence: {
          format: "wasmhatch.operator-workspace.v1",
          file_name: exported.fileName,
          files: exported.manifest.files.length,
          text_bytes: exported.manifest.totalBytes,
          archive_bytes: exported.bytes.byteLength,
          active_artifact_path: exported.manifest.activeArtifactPath
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Operator workspace export failed.";
      setError(message);
      setStatus("Operator workspace export blocked");
      record({ title: "Operator workspace export blocked", detail: message, tone: "muted", category: "export", outcome: "failed" });
    } finally {
      setWorkspaceArchiveBusy(false);
    }
  };

  const stageOperatorWorkspaceRestore = async (file: File) => {
    if (workspaceArchiveBusy || committing) return;
    if (!ensureJournalCapacity(2)) return;
    setWorkspaceArchiveBusy(true);
    setError("");
    try {
      if (!file.size || file.size > OPERATOR_WORKSPACE_BUNDLE_LIMITS.archiveBytes) {
        throw new Error("Choose a non-empty WasmHatch operator workspace ZIP up to 8 MB.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const policyDecision = createPolicyDecisionEnvelope({
        policyId: EXPLICIT_APPROVAL_POLICY,
        capability: "workspace.replace",
        resource: OPERATOR_WORKSPACE_ROOT,
        decision: "stage",
        actor: "host-policy",
        reason: "Allow an exact restore proposal only; the current workspace identity must be rechecked before replacement."
      });
      const proposal = await prepareOperatorWorkspaceRestore(workspace.current, bytes, policyDecision.decisionId);
      setPendingWorkspaceClear(null);
      setPendingWorkspaceRestore({ fileName: file.name, bytes, proposal });
      setStatus(`${proposal.bundle.files.length} restored files ready for review`);
      record({
        title: "Policy allowed workspace restore staging",
        detail: `${policyDecision.decisionId.slice(-12)} · replacement authority not granted`,
        tone: "accent",
        category: "policy",
        outcome: "allowed",
        evidence: { decision_id: policyDecision.decisionId, capability: policyDecision.capability, decision: policyDecision.decision }
      });
      record({
        title: "Operator workspace restore proposal prepared",
        detail: `${proposal.proposalId.slice(-12)} · replace ${proposal.base.files.length} current files with ${proposal.bundle.files.length} reviewed files · ${proposal.bundle.totalBytes} B`,
        tone: "accent",
        category: "proposal",
        outcome: "prepared",
        evidence: {
          proposal_id: proposal.proposalId,
          policy_decision_id: proposal.policyDecisionId,
          archive_sha256: proposal.archiveSha256,
          base_sha256: proposal.base.sha256,
          current_files: proposal.base.files.length,
          restored_files: proposal.bundle.files.length,
          restored_bytes: proposal.bundle.totalBytes,
          active_artifact_path: proposal.bundle.activeArtifactPath
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Operator workspace restore could not be staged.";
      setPendingWorkspaceRestore(null);
      setError(message);
      setStatus("Operator workspace restore blocked");
      record({ title: "Operator workspace restore blocked", detail: message, tone: "muted", category: "proposal", outcome: "failed", evidence: { file_name: file.name } });
    } finally {
      setWorkspaceArchiveBusy(false);
      if (workspaceBundleInput.current) workspaceBundleInput.current.value = "";
    }
  };

  const approveOperatorWorkspaceRestore = async () => {
    if (!pendingWorkspaceRestore || committing) return;
    if (!ensureJournalCapacity(2) || !ensureJournalCapacity(4, true)) return;
    planningAbort.current?.abort();
    authorityEpoch.current += 1;
    invalidateProposal("operator workspace restore approved");
    setCommitting(true);
    setError("");
    const { proposal: restoreProposal, bytes } = pendingWorkspaceRestore;
    record({
      title: "Operator workspace restore approved",
      detail: `${restoreProposal.proposalId.slice(-12)} · exact archive and current base only`,
      tone: "accent",
      category: "approval",
      outcome: "approved",
      evidence: { proposal_id: restoreProposal.proposalId, actor: "foreground-user", decision: "approve" }
    });
    try {
      const outcome = await executeOperatorWorkspaceRestore(workspace.current, bytes, restoreProposal);
      if (outcome.status === "conflict") {
        setPendingWorkspaceRestore(null);
        refreshWorkspaceArtifacts();
        setStatus("Workspace restore blocked by a newer local state");
        setError("The operator workspace changed after this restore was reviewed. Stage the ZIP again against the current workspace.");
        record({
          title: "Operator workspace restore blocked: conflict",
          detail: `expected ${outcome.expectedBaseSha256.slice(-12)} · observed ${outcome.observedBaseSha256.slice(-12)} · no files replaced`,
          tone: "muted",
          category: "effect",
          outcome: "conflict",
          evidence: { proposal_id: restoreProposal.proposalId, expected_base_sha256: outcome.expectedBaseSha256, observed_base_sha256: outcome.observedBaseSha256 }
        });
        return;
      }
      if (!outcome.bundle) throw new Error("Committed restore did not return its validated bundle.");
      adoptRestoredWorkspace(outcome.bundle);
      setPendingWorkspaceRestore(null);
      setStatus(`Restored and verified ${outcome.receipt.files} workspace files`);
      record({
        title: "Operator workspace restore committed",
        detail: `${outcome.receipt.receiptId.slice(-12)} · ${outcome.receipt.files} files · ${outcome.receipt.totalBytes} B · active ${outcome.receipt.activeArtifactPath ?? "none"}`,
        tone: "accent",
        category: "effect",
        outcome: "committed",
        evidence: {
          proposal_id: restoreProposal.proposalId,
          receipt_id: outcome.receipt.receiptId,
          files: outcome.receipt.files,
          bytes: outcome.receipt.totalBytes,
          active_artifact_path: outcome.receipt.activeArtifactPath
        }
      });
    } catch (caught) {
      const uncertain = caught instanceof OperatorWorkspaceRestoreUncertainError;
      const message = caught instanceof Error ? caught.message : "Operator workspace restore failed.";
      if (uncertain) {
        setPendingWorkspaceRestore(null);
        refreshWorkspaceArtifacts();
      }
      setError(message);
      setStatus(uncertain ? "Workspace restore outcome requires recovery" : "Workspace restore failed; previous state verified");
      record({
        title: uncertain ? "Operator workspace restore uncertain" : "Operator workspace restore failed safely",
        detail: message,
        tone: "muted",
        category: "effect",
        outcome: uncertain ? "uncertain" : "failed",
        evidence: { proposal_id: restoreProposal.proposalId, rollback_verified: !uncertain }
      });
    } finally {
      setCommitting(false);
    }
  };

  const rejectOperatorWorkspaceRestore = () => {
    if (!pendingWorkspaceRestore || committing) return;
    const proposalId = pendingWorkspaceRestore.proposal.proposalId;
    setPendingWorkspaceRestore(null);
    setStatus("Operator workspace restore rejected; current files unchanged");
    record({ title: "Operator workspace restore rejected", detail: proposalId.slice(-12), tone: "muted", category: "approval", outcome: "rejected", evidence: { proposal_id: proposalId, actor: "foreground-user", decision: "reject" } });
  };

  const stageOperatorWorkspaceClear = async () => {
    if (workspaceArchiveBusy || committing) return;
    if (!ensureJournalCapacity(2)) return;
    setWorkspaceArchiveBusy(true);
    setError("");
    try {
      const policyDecision = createPolicyDecisionEnvelope({
        policyId: EXPLICIT_APPROVAL_POLICY,
        capability: "workspace.clear",
        resource: OPERATOR_WORKSPACE_ROOT,
        decision: "stage",
        actor: "host-policy",
        reason: "Allow an exact clear proposal only; the listed workspace identity must be rechecked before deletion."
      });
      const clearProposal = await prepareOperatorWorkspaceClear(workspace.current, policyDecision.decisionId);
      if (!clearProposal.base.files.length) throw new Error("The operator workspace is already empty.");
      setPendingWorkspaceRestore(null);
      setPendingWorkspaceClear(clearProposal);
      setStatus(`${clearProposal.base.files.length} workspace files ready for clear review`);
      record({
        title: "Policy allowed workspace clear staging",
        detail: `${policyDecision.decisionId.slice(-12)} · delete authority not granted`,
        tone: "accent",
        category: "policy",
        outcome: "allowed",
        evidence: { decision_id: policyDecision.decisionId, capability: policyDecision.capability, decision: policyDecision.decision }
      });
      record({
        title: "Operator workspace clear proposal prepared",
        detail: `${clearProposal.proposalId.slice(-12)} · ${clearProposal.base.files.length} exact files · export before approval if needed`,
        tone: "accent",
        category: "proposal",
        outcome: "prepared",
        evidence: {
          proposal_id: clearProposal.proposalId,
          policy_decision_id: clearProposal.policyDecisionId,
          base_sha256: clearProposal.base.sha256,
          files: clearProposal.base.files.length,
          bytes: clearProposal.base.files.reduce((total, file) => total + file.bytes, 0)
        }
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Operator workspace clear could not be staged.";
      setPendingWorkspaceClear(null);
      setError(message);
      setStatus("Operator workspace clear blocked");
      record({ title: "Operator workspace clear blocked", detail: message, tone: "muted", category: "proposal", outcome: "failed" });
    } finally {
      setWorkspaceArchiveBusy(false);
    }
  };

  const approveOperatorWorkspaceClear = async () => {
    if (!pendingWorkspaceClear || committing) return;
    if (!ensureJournalCapacity(2) || !ensureJournalCapacity(4, true)) return;
    planningAbort.current?.abort();
    authorityEpoch.current += 1;
    invalidateProposal("operator workspace clear approved");
    setCommitting(true);
    setError("");
    const clearProposal = pendingWorkspaceClear;
    record({
      title: "Operator workspace clear approved",
      detail: `${clearProposal.proposalId.slice(-12)} · ${clearProposal.base.files.length} exact files`,
      tone: "accent",
      category: "approval",
      outcome: "approved",
      evidence: { proposal_id: clearProposal.proposalId, actor: "foreground-user", decision: "approve" }
    });
    try {
      const outcome = await executeOperatorWorkspaceClear(workspace.current, clearProposal);
      if (outcome.status === "conflict") {
        setPendingWorkspaceClear(null);
        refreshWorkspaceArtifacts();
        setStatus("Workspace clear blocked by a newer local state");
        setError("The operator workspace changed after clear review. Review the current files again.");
        record({
          title: "Operator workspace clear blocked: conflict",
          detail: `expected ${outcome.expectedBaseSha256.slice(-12)} · observed ${outcome.observedBaseSha256.slice(-12)} · no files deleted`,
          tone: "muted",
          category: "effect",
          outcome: "conflict",
          evidence: { proposal_id: clearProposal.proposalId, expected_base_sha256: outcome.expectedBaseSha256, observed_base_sha256: outcome.observedBaseSha256 }
        });
        return;
      }
      adoptRestoredWorkspace({
        manifest: {
          schemaVersion: 1,
          kind: "wasmhatch.operator-workspace",
          exportedAt: new Date().toISOString(),
          activeArtifactPath: null,
          files: [],
          totalBytes: 0
        },
        files: []
      });
      setPendingWorkspaceClear(null);
      setStatus(`Cleared and verified ${outcome.receipt.files} operator workspace files`);
      record({
        title: "Operator workspace clear committed",
        detail: `${outcome.receipt.receiptId.slice(-12)} · ${outcome.receipt.files} files · legacy coding workspace untouched`,
        tone: "accent",
        category: "effect",
        outcome: "committed",
        evidence: { proposal_id: clearProposal.proposalId, receipt_id: outcome.receipt.receiptId, files: outcome.receipt.files, bytes: outcome.receipt.totalBytes }
      });
    } catch (caught) {
      const uncertain = caught instanceof OperatorWorkspaceRestoreUncertainError;
      const message = caught instanceof Error ? caught.message : "Operator workspace clear failed.";
      if (uncertain) {
        setPendingWorkspaceClear(null);
        refreshWorkspaceArtifacts();
      }
      setError(message);
      setStatus(uncertain ? "Workspace clear outcome requires recovery" : "Workspace clear failed; previous state verified");
      record({
        title: uncertain ? "Operator workspace clear uncertain" : "Operator workspace clear failed safely",
        detail: message,
        tone: "muted",
        category: "effect",
        outcome: uncertain ? "uncertain" : "failed",
        evidence: { proposal_id: clearProposal.proposalId, rollback_verified: !uncertain }
      });
    } finally {
      setCommitting(false);
    }
  };

  const rejectOperatorWorkspaceClear = () => {
    if (!pendingWorkspaceClear || committing) return;
    const proposalId = pendingWorkspaceClear.proposalId;
    setPendingWorkspaceClear(null);
    setStatus("Operator workspace clear rejected; files unchanged");
    record({ title: "Operator workspace clear rejected", detail: proposalId.slice(-12), tone: "muted", category: "approval", outcome: "rejected", evidence: { proposal_id: proposalId, actor: "foreground-user", decision: "reject" } });
  };

  const exportRunJournal = () => {
    setError("");
    try {
      const currentJournal = runJournal.current ?? initialOperatorJournal();
      const ordinaryLimit = RUN_JOURNAL_LIMITS.maxEvents - RUN_JOURNAL_LIMITS.reservedTerminalEvents;
      const nextJournal = currentJournal.events.length < ordinaryLimit
        ? record({
            title: "Run journal exported",
            detail: "Structured events and pilot timing metrics · credential fields and source contents excluded · task/resource text defensively redacted",
            tone: "accent",
            category: "export",
            outcome: "completed",
            evidence: { format: "wasmhatch.run-journal.v1", event_count: currentJournal.events.length + 1 }
          })
        : currentJournal;
      const context = {
        task,
        source: source === "artifact"
          ? {
              kind: "artifact" as const,
              connectorId: null,
              resource: artifactWorkspacePath ?? artifact?.sourceName ?? "memory-only artifact",
              sourceSha256: artifact?.sourceSha256 ?? null
            }
          : source === "google"
            ? {
                kind: "google" as const,
                connectorId: GOOGLE_SHEETS_MANIFEST.id,
                resource: loadedGoogleTarget ? `google-sheets:${loadedGoogleTarget.spreadsheetIdSha256}:${loadedGoogleTarget.range}` : "unloaded Google Sheets target",
                sourceSha256: null
              }
            : {
                kind: "demo" as const,
                connectorId: LOCAL_SPREADSHEET_MANIFEST.id,
                resource: "local-demo:Demo!A1",
                sourceSha256: null
              }
      };
      const serialized = serializeRunJournal(nextJournal, context);
      const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `wasmhatch-run-${nextJournal.runId.slice(-8)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Exported run journal ${nextJournal.runId.slice(-8)}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Run journal export failed.";
      setError(message);
      setStatus("Run journal export blocked");
    }
  };

  const googleArtifactReadReady = source === "google" && Boolean(loadedGoogleTarget) && googleAuthStatus.connected;

  return (
    <main className="operator-app">
      <header className="operator-header">
        <a href={homeUrl} className="operator-brand"><span>WH</span><strong>WasmHatch</strong></a>
        <div className="operator-title">
          <small>Business operator / foundation slice</small>
          <strong>Business artifact operation</strong>
        </div>
        <div className="operator-status"><i /> {status}</div>
        <a href={`${homeUrl}?view=workspace`} className="operator-legacy"><ArrowLeft size={14} /> Legacy coding workspace</a>
      </header>

      <div className="operator-layout">
        <aside className="operator-connectors" aria-label="Sources and connectors">
          <div className="operator-panel-heading"><span>Sources</span><small>bounded authority</small></div>
          <button className={source === "demo" ? "connector-row active" : "connector-row"} onClick={resetDemo} disabled={committing}>
            <Database size={16} /><span><strong>Local demo</strong><small>No network</small></span><Check size={14} />
          </button>
          <button className={source === "artifact" ? "connector-row active" : "connector-row"} onClick={() => artifactInput.current?.click()} disabled={committing || importingArtifact}>
            <UploadCloud size={16} /><span><strong>{importingArtifact ? "Validating file…" : artifact?.sourceName ?? "CSV / XLSX"}</strong><small>{artifact ? `${artifact.sheetName} · ${artifact.rows}×${artifact.columns}` : "Worker-isolated value import"}</small></span>{source === "artifact" && <Check size={14} />}
          </button>
          <input ref={artifactInput} className="operator-file-input" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Import CSV or XLSX" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importLocalArtifact(file);
          }} />
          <div className="connector-form artifact-actions">
            <div><button onClick={() => void exportWorkingData("csv")} disabled={committing || importingArtifact || exportingArtifact}><Download size={13} /> {exportingArtifact ? "Exporting…" : "Export safe CSV"}</button><button className="secondary-artifact" onClick={() => void exportWorkingData("xlsx")} disabled={committing || importingArtifact || exportingArtifact}><Download size={13} /> Export value-only XLSX</button></div>
            <p>Imports run in a Worker. Macros are rejected; formulas and external links never execute. The normalized JSON snapshot is stored without the original workbook payload.</p>
            {artifactFile && artifact && artifact.sheets.filter((sheet) => sheet.visibility === "visible").length > 1 && <div className="artifact-sheet-picker"><label>Visible worksheet<select value={artifactSheetChoice} onChange={(event) => setArtifactSheetChoice(event.target.value)} disabled={committing || importingArtifact}>{artifact.sheets.filter((sheet) => sheet.visibility === "visible").map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}</select></label><button onClick={() => void importLocalArtifact(artifactFile, artifactSheetChoice)} disabled={committing || importingArtifact || artifactSheetChoice === artifact.sheetName}>Load sheet</button></div>}
            {artifact && <dl className="artifact-provenance"><div><dt>Source</dt><dd>{formatArtifactBytes(artifact.sourceBytes)} · {artifact.sourceSha256.slice(0, 12)}</dd></div><div><dt>Workspace</dt><dd>{artifactWorkspacePath ?? "memory only"}</dd></div><div><dt>Warnings</dt><dd>{artifact.warnings.length} · formulas {artifact.formulaCells} · links {artifact.externalLinks}</dd></div></dl>}
          </div>
          <div className="connector-form workspace-artifacts">
            <div className="workspace-artifact-heading">
              <span>Workspace artifacts</span>
              <small>{workspaceArtifacts.length} files · {formatArtifactBytes(workspaceArtifactTotalBytes)}</small>
              <button onClick={refreshWorkspaceArtifacts} disabled={workspaceArtifactBusy || committing} aria-label="Refresh workspace artifacts"><RefreshCw size={12} /></button>
            </div>
            {workspaceAttachment && (
              <div className="workspace-attachment" aria-label="AI workspace attachment">
                <Paperclip size={13} />
                <span><strong>AI attachment</strong><small>{workspaceAttachment.path} · {workspaceAttachment.sha256.slice(-12)}</small></span>
                <button onClick={detachWorkspaceArtifact} disabled={planning || committing} aria-label="Detach workspace artifact from AI"><X size={12} /></button>
              </div>
            )}
            <div className="workspace-artifact-list" role="listbox" aria-label="Operator workspace artifacts">
              {workspaceArtifacts.map((workspaceArtifact) => (
                <button
                  key={workspaceArtifact.path}
                  className={selectedWorkspaceArtifact?.path === workspaceArtifact.path ? "active" : ""}
                  role="option"
                  aria-selected={selectedWorkspaceArtifact?.path === workspaceArtifact.path}
                  onClick={() => void inspectWorkspaceArtifact(workspaceArtifact)}
                  disabled={workspaceArtifactBusy || committing}
                >
                  <FileText size={13} />
                  <span><strong>{workspaceArtifact.name}</strong><small>{workspaceArtifact.root}/ · {workspaceArtifact.kind} · {formatArtifactBytes(workspaceArtifact.bytes)}</small></span>
                  {workspaceArtifact.tabularSnapshot && <em>table</em>}
                </button>
              ))}
              {!workspaceArtifactBusy && !workspaceArtifacts.length && !workspaceArtifactError && <p>No Operator artifacts yet.</p>}
              {workspaceArtifactBusy && !workspaceArtifacts.length && <p>Indexing isolated workspace…</p>}
            </div>
            {workspaceArtifactError && <p className="workspace-artifact-error" role="alert">{workspaceArtifactError}</p>}
            {workspaceArtifactPreview && (
              <div className="workspace-artifact-preview" aria-label="Workspace artifact preview">
                <header><span>{workspaceArtifactPreview.artifact.path}</span><button onClick={() => { setSelectedWorkspaceArtifact(null); setWorkspaceArtifactPreview(null); }} aria-label="Close workspace artifact preview"><X size={12} /></button></header>
                <small>{workspaceArtifactPreview.artifact.mediaType} · {workspaceArtifactPreview.artifact.lines} lines · {workspaceArtifactPreview.artifact.sha256.slice(-12)}</small>
                <pre>{workspaceArtifactPreview.content || "(empty file)"}</pre>
                <footer>{workspaceArtifactPreview.truncated ? `Preview limited to ${formatArtifactBytes(workspaceArtifactPreview.previewBytes)} / ${workspaceArtifactPreview.previewLines} lines.` : "Complete local preview."}</footer>
                <button className="attach-workspace-artifact" onClick={() => void attachWorkspaceArtifact()} disabled={workspaceArtifactBusy || committing || workspaceAttachment?.path === workspaceArtifactPreview.artifact.path && workspaceAttachment.sha256 === workspaceArtifactPreview.artifact.sha256}><Paperclip size={13} /> {workspaceAttachment?.path === workspaceArtifactPreview.artifact.path && workspaceAttachment.sha256 === workspaceArtifactPreview.artifact.sha256 ? "Attached to next AI plan" : "Attach exact file to AI plan"}</button>
              </div>
            )}
            <p>Previews stay local and are capped at 24 KB / 200 lines. AI receives nothing until an exact file is attached and a checkpointed tool requests bounded content.</p>
          </div>
          <div className="connector-form workspace-recovery">
            <div className="workspace-recovery-actions">
              <button onClick={() => void exportOperatorWorkspace()} disabled={committing || workspaceArchiveBusy}><Download size={13} /> {workspaceArchiveBusy ? "Checking…" : "Export workspace"}</button>
              <button className="secondary-recovery" onClick={() => workspaceBundleInput.current?.click()} disabled={committing || workspaceArchiveBusy}><UploadCloud size={13} /> Review restore</button>
            </div>
            <input ref={workspaceBundleInput} className="operator-file-input" type="file" accept=".zip,application/zip" aria-label="Restore operator workspace ZIP" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void stageOperatorWorkspaceRestore(file);
            }} />
            <button className="clear-operator-workspace" onClick={() => void stageOperatorWorkspaceClear()} disabled={committing || workspaceArchiveBusy}>Review workspace clear</button>
            <p>Portable ZIP contains only bounded text artifacts from the isolated Operator namespace. Restore and clear bind the reviewed file set, recheck it, verify the result, and roll back on a proven failure.</p>
            {pendingWorkspaceRestore && (
              <div className="workspace-recovery-review" role="group" aria-label="Operator workspace restore review">
                <strong>Restore approval required</strong>
                <span>{pendingWorkspaceRestore.fileName}</span>
                <code>{pendingWorkspaceRestore.proposal.proposalId.slice(-12)} · base {pendingWorkspaceRestore.proposal.base.sha256.slice(-12)}</code>
                <p>Replace {pendingWorkspaceRestore.proposal.base.files.length} current files with {pendingWorkspaceRestore.proposal.bundle.files.length} files ({formatArtifactBytes(pendingWorkspaceRestore.proposal.bundle.totalBytes)}).</p>
                <pre>{pendingWorkspaceRestore.proposal.bundle.files.map((file) => `${file.path} · ${file.bytes} B · ${file.sha256.slice(-12)}`).join("\n") || "(restore to an empty workspace)"}</pre>
                <button onClick={() => void approveOperatorWorkspaceRestore()} disabled={committing}>Approve exact restore</button>
                <button className="reject-recovery" onClick={rejectOperatorWorkspaceRestore} disabled={committing}>Reject restore</button>
              </div>
            )}
            {pendingWorkspaceClear && (
              <div className="workspace-recovery-review danger" role="group" aria-label="Operator workspace clear review">
                <strong>Clear approval required</strong>
                <code>{pendingWorkspaceClear.proposalId.slice(-12)} · base {pendingWorkspaceClear.base.sha256.slice(-12)}</code>
                <p>Delete these {pendingWorkspaceClear.base.files.length} exact Operator files. The legacy coding workspace is a separate namespace.</p>
                <pre>{pendingWorkspaceClear.base.files.map((file) => `${file.path} · ${file.bytes} B · ${file.sha256.slice(-12)}`).join("\n")}</pre>
                <button onClick={() => void approveOperatorWorkspaceClear()} disabled={committing}>Approve exact clear</button>
                <button className="reject-recovery" onClick={rejectOperatorWorkspaceClear} disabled={committing}>Reject clear</button>
              </div>
            )}
          </div>
          <div className={source === "google" ? "connector-row active static" : "connector-row static"}>
            <Table2 size={16} /><span><strong>Google Sheets</strong><small>{googleConnectionLabel(googleAuthStatus)}</small></span>
            {googleAuthStatus.connected && <Check size={14} />}
          </div>
          <div className="connector-row static planner-connector">
            <Bot size={16} /><span><strong>OpenAI planner</strong><small>Responses API · bounded tools</small></span>
          </div>
          <div className="connector-form planner-credentials">
            <label>Session API key<input type="password" value={plannerApiKey} onChange={(event) => setPlannerApiKey(event.target.value)} autoComplete="off" placeholder="Memory only" aria-label="OpenAI session API key" disabled={committing || planning} /></label>
            <label>Planning model
              <select value={plannerModel} onChange={(event) => setPlannerModel(event.target.value)} aria-label="Planning model" disabled={committing || planning}>
                <option value="gpt-5.6-luna">GPT-5.6 Luna · efficient</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra · balanced</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol · highest capability</option>
              </select>
            </label>
            <p>The key stays in this tab and is used only in the Authorization header. It never enters spreadsheet data, the model prompt, or the Wasm worker.</p>
          </div>
          <div className="connector-form">
            <label>Google OAuth Web client ID<input value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} autoComplete="off" placeholder="123…apps.googleusercontent.com" aria-label="Google OAuth Web client ID" disabled={committing || connectingGoogle || revokingGoogle || googleAuthStatus.connected} /></label>
            <button onClick={() => void connectGoogle()} disabled={committing || connectingGoogle || revokingGoogle || !googleClientId.trim()}>
              <KeyRound size={13} /> {connectingGoogle ? "Authorizing…" : googleAuthStatus.connected ? "Switch Google account" : googleAuthStatus.state === "expired" ? "Reconnect Google Sheets" : "Connect Google Sheets"}
            </button>
            {googleAuthStatus.connected && (
              <button className="revoke-google" onClick={() => void revokeGoogle()} disabled={committing || connectingGoogle || revokingGoogle}>
                {revokingGoogle ? "Revoking…" : "Revoke Google access"}
              </button>
            )}
            <label>Spreadsheet ID<input value={spreadsheetId} onChange={(event) => {
              planningAbort.current?.abort();
              authorityEpoch.current += 1;
              setSpreadsheetId(event.target.value);
              if (source === "google") {
                invalidateProposal("Google spreadsheet target edited");
                setLoadedGoogleTarget(null);
                setStatus("Target changed — read the range again");
              }
            }} placeholder="1abc…" disabled={committing} /></label>
            <label>Range<input value={range} onChange={(event) => {
              planningAbort.current?.abort();
              authorityEpoch.current += 1;
              setRange(event.target.value);
              if (source === "google") {
                invalidateProposal("Google range target edited");
                setLoadedGoogleTarget(null);
                setStatus("Target changed — read the range again");
              }
            }} placeholder="Sheet1!A1:D20" disabled={committing} /></label>
            <button onClick={() => void loadGoogleSheet()} disabled={committing || connectingGoogle || revokingGoogle || !googleAuthStatus.connected || !spreadsheetId.trim() || !range.trim()}>
              <RefreshCw size={13} /> Read range
            </button>
            {googleArtifactReadReady && loadedGoogleTarget && (
              <div className="google-ai-grant" role="status">
                <ShieldCheck size={13} />
                <span><strong>AI read grant ready</strong><small>{loadedGoogleTarget.range} · exact read-only target</small></span>
                <em>snapshot on request</em>
              </div>
            )}
            <p>Requests the sensitive Sheets read/write scope for this foreground session only. The host broker attaches the short-lived token after validating connector operation and exact target. It is never persisted or exposed to connector, model, or script code.</p>
          </div>
          <div className="operator-scope">
            <ShieldCheck size={16} />
            <div><strong>Current boundary</strong><p>Foreground GIS token model. Expiry requires a new user gesture; no refresh token, scheduling, or unattended write.</p></div>
          </div>
        </aside>

        <section className="operator-workbench">
          <div className="operator-panel-heading"><span>Working data</span><small>{rows.length} rows · {Math.max(0, ...rows.map((row) => row.length))} columns{rows.length > TABLE_PREVIEW_ROWS ? ` · previewing ${TABLE_PREVIEW_ROWS}` : ""}</small></div>
          {showLocalDemoGuide && source === "demo" && (
            <div className={localDemoCompleted ? "operator-demo-guide complete" : proposal ? "operator-demo-guide review" : "operator-demo-guide"} role="region" aria-label="60-second local demo" aria-live="polite">
              <span className="operator-demo-step">{localDemoCompleted ? "03" : proposal ? "02" : "01"}</span>
              <div>
                <strong>{localDemoCompleted ? "Local loop complete" : proposal ? `${changes.length} typed changes staged` : "60-second local demo"}</strong>
                <small>{localDemoCompleted
                  ? "The approved values changed only in this tab. Import a CSV/XLSX when you are ready for your own data."
                  : proposal
                    ? "Review the exact before/after cells. Nothing has been written yet."
                    : "No account or API key. Run the preset in QuickJS, inspect the cell diff, then choose whether to apply it."}</small>
              </div>
              <button className="operator-demo-action" onClick={() => {
                if (localDemoCompleted) setShowLocalDemoGuide(false);
                else if (proposal) document.querySelector<HTMLElement>(".operator-review")?.scrollIntoView({ behavior: "smooth", block: "start" });
                else void runScript();
              }} disabled={committing || planning}>{localDemoCompleted ? "Done" : proposal ? "Review changes" : "Run bounded transform"}</button>
              <button className="operator-demo-close" onClick={() => setShowLocalDemoGuide(false)} aria-label="Dismiss local demo guide"><X size={13} /></button>
            </div>
          )}
          <div className="operator-table-wrap">
            <table className="operator-table">
              <tbody>
                {rows.slice(0, TABLE_PREVIEW_ROWS).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th>{rowIndex + 1}</th>
                    {row.map((cell, columnIndex) => <td key={columnIndex}>{displayCell(cell)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > TABLE_PREVIEW_ROWS && <p className="operator-table-limit">Preview limited to the first {TABLE_PREVIEW_ROWS} rows. The bounded snapshot retains all {rows.length} rows.</p>}
          </div>

          <div className="operator-task">
            <div className="operator-task-label"><Sparkles size={14} /><span>Task intent</span><small>AI may propose; only you can run and write</small></div>
            <textarea value={task} onChange={(event) => { planningAbort.current?.abort(); taskRevision.current += 1; setTask(event.target.value); clearAiPlans(); invalidateProposal("task intent edited"); }} aria-label="Business task" disabled={committing} />
            <div className="operator-plan-mode" role="group" aria-label="AI plan output mode">
              <button className={planMode === "spreadsheet-transform" ? "active" : ""} aria-pressed={planMode === "spreadsheet-transform"} onClick={() => changePlanMode("spreadsheet-transform")} disabled={planning || committing}><span>Table transform</span><small>typed cells</small></button>
              <button className={planMode === "artifact-output" ? "active" : ""} aria-pressed={planMode === "artifact-output"} onClick={() => changePlanMode("artifact-output")} disabled={planning || committing}><span>Artifact output</span><small>one reviewed file</small></button>
            </div>
            <div className="operator-planner-actions">
              <button onClick={() => planning ? cancelPlanning() : void draftWithAI()} disabled={committing || (!planning && (!plannerApiKey.trim() || !task.trim() || planMode === "artifact-output" && !workspaceAttachment && !(source === "artifact" && artifactWorkspacePath) && !googleArtifactReadReady))}>
                {planning ? <Square size={12} /> : <KeyRound size={14} />}{planning ? "Cancel AI run" : planMode === "artifact-output" ? "Draft artifact with AI" : workspaceAttachment || source === "artifact" && artifactWorkspacePath ? "Inspect workspace with AI" : "Draft with AI"}
              </button>
              <span>{planMode === "artifact-output" && !workspaceAttachment && !(source === "artifact" && artifactWorkspacePath) && !googleArtifactReadReady
                ? "Attach a workspace file, import a local table, or load a connected Google Sheets range before proposing one output file."
                : planMode === "artifact-output" && googleArtifactReadReady && loadedGoogleTarget
                  ? `Grants one host-bound read of ${loadedGoogleTarget.range}${workspaceAttachment ? ` plus ${workspaceAttachment.path}` : ""}. On tool request, the broker re-reads only that range and persists a credential-free, identity-bound snapshot; the provider ID and token stay excluded.`
                : workspaceAttachment
                ? `Grants identity-bound ${workspaceAttachment.path}${source === "artifact" && artifactWorkspacePath !== workspaceAttachment.path ? " plus the active table" : ""}. Only tool-requested bounded content is sent; live OPFS and credentials stay excluded.`
                : source === "artifact" && artifactWorkspacePath
                  ? "Grants one identity-bound snapshot path. Only tool-requested bounded rows are sent to OpenAI; credentials and live OPFS stay excluded."
                : `Explicitly sends this task and ${rows.length} visible rows to OpenAI. Sheets and API credentials are excluded.`}</span>
            </div>
          </div>

          {plan && (
            <div className="operator-plan" aria-label="AI transformation plan">
              <div><Bot size={15} /><strong>Staged AI plan</strong><small>{plan.model}</small></div>
              <h3>{plan.summary}</h3>
              <p><b>Expected effect</b>{plan.expectedEffect}</p>
              {!!plan.assumptions.length && <p><b>Verify assumptions</b>{plan.assumptions.join(" · ")}</p>}
              {!!plan.warnings.length && <p className="warning"><b>Warnings</b>{plan.warnings.join(" · ")}</p>}
              <footer>{agentBudget && agentTrace.length
                ? `${agentBudget.modelRequests} model requests · ${agentBudget.toolCalls} checkpointed tools · ${agentBudget.egressBytes} B tool egress. Script copied below; it has not run and no write has occurred.`
                : "Script copied below for inspection. It has not run and no write has occurred."}</footer>
            </div>
          )}

          {artifactWorkflowDraft && (
            <div className="operator-plan artifact-workflow-plan" aria-label="AI artifact workflow plan">
              <div><FileText size={15} /><strong>Staged artifact workflow</strong><small>{artifactWorkflowDraft.plan.model}</small></div>
              <h3>{artifactWorkflowDraft.plan.summary}</h3>
              <p><b>Expected effect</b>{artifactWorkflowDraft.plan.expectedEffect}</p>
              <dl><div><dt>Output</dt><dd>{artifactWorkflowDraft.plan.outputPath}</dd></div><div><dt>Type</dt><dd>{artifactWorkflowDraft.plan.outputMediaType}</dd></div><div><dt>Inputs</dt><dd>{artifactWorkflowDraft.inputs.length} exact hashes</dd></div></dl>
              {!!artifactWorkflowDraft.plan.assumptions.length && <p><b>Verify assumptions</b>{artifactWorkflowDraft.plan.assumptions.join(" · ")}</p>}
              {!!artifactWorkflowDraft.plan.warnings.length && <p className="warning"><b>Warnings</b>{artifactWorkflowDraft.plan.warnings.join(" · ")}</p>}
              <footer>{artifactWorkflowDraft.plan.script !== script ? "Script edited after the AI plan. The current source will be saved, snapshotted, and shown as a file diff before any output write." : `${agentBudget?.modelRequests ?? 0} model requests · ${agentBudget?.toolCalls ?? 0} checkpointed tools · ${agentBudget?.egressBytes ?? 0} B tool egress. Source is staged below; it has not run.`}</footer>
            </div>
          )}

          <div className="operator-script">
            <div className="operator-task-label"><span>{planMode === "artifact-output" ? "Artifact workflow script" : "Sandbox script"}</span><small>QuickJS · Wasm worker · no fetch or DOM</small></div>
            <textarea value={script} onChange={(event) => { scriptRevision.current += 1; setScript(event.target.value); if (planMode === "spreadsheet-transform") setPlan(null); invalidateProposal("sandbox script edited"); }} spellCheck={false} aria-label="Sandbox transformation script" placeholder={planMode === "artifact-output" ? "Draft an identity-bound artifact workflow with AI." : undefined} disabled={committing} />
            <div className="operator-script-actions">
              {planMode === "spreadsheet-transform" && <button onClick={() => void runScript()} disabled={committing || connectingGoogle || revokingGoogle || (source === "google" && !loadedGoogleTarget)}><Play size={14} /> Run in Wasm sandbox</button>}
              {(artifactWorkflowDraft || artifact && artifactWorkspacePath) && <button className="workspace-output" onClick={() => void runWorkspaceOutput()} disabled={committing || runningWorkspaceScript || !script.trim()}><UploadCloud size={14} /> {runningWorkspaceScript ? "Running snapshot…" : artifactWorkflowDraft ? "Run & stage artifact diff" : "Save & stage workspace output"}</button>}
              <span>{artifactWorkflowDraft ? `${artifactWorkflowDraft.inputs.length} exact inputs · 1 transient output · 750 ms · 32 MB` : "JSON transform or manifest-bound snapshot VFS · 750 ms · 32 MB"}</span>
            </div>
          </div>
          {error && <p className="operator-error" role="alert">{error}</p>}
        </section>

        <aside className="operator-review" aria-label="Review and audit">
          <div className="operator-panel-heading"><span>Write review</span><small>{workspaceProposal ? "1 file" : `${changes.length} changes`}</small></div>
          {workspaceProposal ? (
            <div className="change-review workspace-file-review">
              <div className="change-summary"><UploadCloud size={18} /><div><strong>Workspace file approval required</strong><p>The sandbox wrote only to a transient mount. Approve this exact diff to save {workspaceProposal.target.workspacePath}.</p></div></div>
              <div className="proposal-identity" role="group" aria-label="Immutable workspace proposal identity">
                <span><b>Proposal</b><code>{workspaceProposal.proposalId.slice(-12)}</code></span>
                <span><b>Run</b><code>{workspaceProposal.run.runId.slice(-12)}</code></span>
                <span><b>Base</b><code>{workspaceProposal.base.sha256.slice(-12)}</code></span>
                <span><b>Payload</b><code>{workspaceProposal.output.bytes} bytes</code></span>
              </div>
              <pre className="workspace-file-diff" aria-label="Workspace file diff">{workspaceDiff.slice(0, 16_000)}{workspaceDiff.length > 16_000 ? "\n… diff preview truncated at 16 KB" : ""}</pre>
              <button className="approve-write" onClick={() => void approveWorkspaceFile()} disabled={committing}>
                <Check size={15} /> {committing ? "Rechecking base…" : "Approve and write workspace file"}
              </button>
              <button className="reject-write" onClick={() => void rejectWorkspaceFile()} disabled={committing}>Reject file proposal</button>
            </div>
          ) : proposal ? (
            <div className="change-review">
              <div className="change-summary"><UploadCloud size={18} /><div><strong>Explicit approval required</strong><p>{changes.length} cell changes will be written to {proposal.connector.id === GOOGLE_SHEETS_MANIFEST.id ? proposal.target.range : source === "artifact" ? "the imported working snapshot" : "the local demo"}.</p></div></div>
              <div className="proposal-identity" role="group" aria-label="Immutable proposal identity">
                <span><b>Proposal</b><code>{proposal.proposalId.slice(-12)}</code></span>
                <span><b>Source check</b><code>{proposal.baseVersion.strength}</code></span>
                <span><b>Snapshot</b><code>{proposal.baseVersion.value.slice(-12)}</code></span>
                <span><b>Payload</b><code>{proposal.mutations.mutations.length} typed cells</code></span>
              </div>
              <div className="change-list">
                {changes.slice(0, 24).map((change) => (
                  <div key={`${change.row}-${change.column}`}>
                    <code>{cellLabel(change.row, change.column)}</code>
                    <span>{displayCell(change.before)}</span>
                    <i>→</i>
                    <strong>{displayCell(change.after)}</strong>
                  </div>
                ))}
                {changes.length > 24 && <p>+ {changes.length - 24} more changes</p>}
              </div>
              <button className="approve-write" onClick={() => void approveWrite()} disabled={committing || connectingGoogle || revokingGoogle || !changes.length}>
                <Check size={15} /> {committing ? "Validating source…" : `Approve and ${proposal.connector.id === GOOGLE_SHEETS_MANIFEST.id ? "write range" : "apply locally"}`}
              </button>
              <button className="reject-write" onClick={() => void rejectWrite()} disabled={committing}>Reject proposal</button>
            </div>
          ) : (
            <div className="empty-review"><ShieldCheck size={22} /><strong>No pending write</strong><p>Run a transform for a cell preview, or stage a workspace output for a file diff. Nothing writes automatically.</p></div>
          )}

          <div className="operator-panel-heading audit-heading"><span>Run journal</span><button className="journal-export" onClick={exportRunJournal} disabled={committing}><Download size={11} /> Export JSON</button></div>
          <div className="operator-audit">
            {audit.map((entry, index) => (
              <div key={`${entry.time}-${index}`} className={entry.tone === "accent" ? "accent" : ""}>
                <time>{entry.time}</time><p><strong>{entry.title}</strong><span>{entry.detail}</span></p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
