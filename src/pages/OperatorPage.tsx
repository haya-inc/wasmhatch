import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Database,
  Download,
  KeyRound,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Table2,
  UploadCloud
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
import {
  type TabularArtifactFormat,
  type TabularArtifactProvenance
} from "../lib/tabular-artifact-contract";
import { normalizedArtifactJson, normalizedArtifactPath } from "../lib/tabular-artifact-persistence";
import { createWorkspaceStore } from "../lib/workspace";

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
  const [task, setTask] = useState("Normalize names and regions, convert amounts to numbers, and standardize stages.");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [plan, setPlan] = useState<SpreadsheetPlan | null>(null);
  const [plannerApiKey, setPlannerApiKey] = useState("");
  const [plannerModel, setPlannerModel] = useState(DEFAULT_PLANNER_MODEL);
  const [planning, setPlanning] = useState(false);
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
  const [googleClientId, setGoogleClientId] = useState(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "");
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [revokingGoogle, setRevokingGoogle] = useState(false);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [range, setRange] = useState("Sheet1!A1:D20");
  const [loadedGoogleTarget, setLoadedGoogleTarget] = useState<{ spreadsheetId: string; range: string } | null>(null);
  const effectExecutor = useRef(new SpreadsheetEffectExecutor());
  const credentialBroker = useRef(new CredentialBroker());
  const googleOAuth = useRef(new GoogleOAuthSession());
  const workspace = useRef(createWorkspaceStore());
  const artifactInput = useRef<HTMLInputElement>(null);
  const authorityEpoch = useRef(0);
  const [googleAuthStatus, setGoogleAuthStatus] = useState(() => googleOAuth.current.status());
  const [audit, setAudit] = useState<AuditEntry[]>([
    { time: "00:00", title: "Local demo loaded", detail: "4 rows · no external request", tone: "muted" }
  ]);

  const changes = useMemo(
    () => proposal ? proposal.mutations.mutations : [],
    [proposal]
  );

  useEffect(() => {
    if (!googleAuthStatus.expiresAt) return;
    const delay = Math.max(0, Date.parse(googleAuthStatus.expiresAt) - Date.now() - 30_000);
    const timer = window.setTimeout(() => setGoogleAuthStatus(googleOAuth.current.status()), delay + 25);
    return () => window.clearTimeout(timer);
  }, [googleAuthStatus.expiresAt]);

  const record = (entry: Omit<AuditEntry, "time">) => {
    const elapsed = audit.length.toString().padStart(2, "0");
    setAudit((current) => [...current, { ...entry, time: `00:${elapsed}` }]);
  };

  const invalidateProposal = (reason: string) => {
    if (!proposal) return;
    record({
      title: "Write proposal invalidated",
      detail: `${proposal.proposalId.slice(-12)} · ${reason}`,
      tone: "muted"
    });
    setProposal(null);
  };

  const runScript = async () => {
    setStatus("Running in Wasm worker…");
    setError("");
    const startingAuthorityEpoch = authorityEpoch.current;
    try {
      if (source === "google" && !loadedGoogleTarget) {
        throw new Error("Read the selected Google Sheets range again before preparing a write.");
      }
      const result = await runBusinessScriptInWorker(script, rows);
      if (startingAuthorityEpoch !== authorityEpoch.current) {
        throw new Error("Google authorization changed during the transform. Read the range and run the script again.");
      }
      const nextRows = spreadsheetRowsFromBusinessValue(result.output);
      const nextProposal = await prepareSpreadsheetEffect({
        connector: source === "google" ? GOOGLE_SHEETS_MANIFEST : LOCAL_SPREADSHEET_MANIFEST,
        target: source === "google"
          ? { ...loadedGoogleTarget!, inputMode: "RAW" }
          : source === "artifact" && artifact
            ? { spreadsheetId: `artifact:${artifact.sourceSha256}`, range: `${artifact.sheetName}!A1`, inputMode: "RAW" }
            : { spreadsheetId: "local-demo", range: "Demo!A1", inputMode: "RAW" },
        baseValues: rows,
        values: nextRows,
        preconditionStrength: "recheck",
        policyDecisionId: EXPLICIT_APPROVAL_POLICY
      });
      setProposal(nextProposal);
      setStatus(`${nextProposal.summary.changedCells} cell changes ready for review`);
      record({
        title: "Typed mutation proposal prepared",
        detail: `${nextProposal.proposalId.slice(-12)} · ${nextProposal.mutations.mutations.length} bound mutations · ${result.inputBytes} B in · ${result.outputBytes} B out · recheck required`,
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sandbox transform failed.";
      setError(message);
      setStatus("Transform failed");
      record({ title: "Sandbox transform blocked", detail: message, tone: "muted" });
    }
  };

  const draftWithAI = async () => {
    setPlanning(true);
    setStatus("Drafting a bounded AI plan…");
    setError("");
    invalidateProposal("AI plan requested");
    try {
      const planner = new OpenAIPlanner(plannerApiKey);
      const nextPlan = await planner.planSpreadsheetTransform({ task, rows, model: plannerModel });
      setPlan(nextPlan);
      setScript(nextPlan.script);
      setStatus("AI plan staged for review");
      record({
        title: "AI plan staged",
        detail: `${nextPlan.model} · ${nextPlan.inputRows} rows / ${nextPlan.inputCells} cells sent · no credential or write`,
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI planning failed.";
      setPlan(null);
      setError(message);
      setStatus("AI plan blocked");
      record({ title: "AI plan blocked", detail: message, tone: "muted" });
    } finally {
      setPlanning(false);
    }
  };

  const connectGoogle = async () => {
    if (connectingGoogle || revokingGoogle) return;
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
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google authorization failed.";
      setGoogleAuthStatus(googleOAuth.current.status());
      setError(message);
      setStatus("Google authorization not completed");
      record({ title: "Google authorization blocked", detail: message, tone: "muted" });
    } finally {
      setConnectingGoogle(false);
    }
  };

  const revokeGoogle = async () => {
    if (connectingGoogle || revokingGoogle) return;
    setRevokingGoogle(true);
    setError("");
    setStatus("Revoking Google access…");
    authorityEpoch.current += 1;
    invalidateProposal("Google access revoked");
    setLoadedGoogleTarget(null);
    setPlan(null);
    setRows(DEMO_ROWS);
    setArtifact(null);
    setArtifactWorkspacePath(null);
    setArtifactFile(null);
    setArtifactSheetChoice("");
    setSource("demo");
    try {
      setGoogleAuthStatus(await googleOAuth.current.revoke());
      setStatus("Google access revoked; local demo restored");
      record({ title: "Google access revoked", detail: "Session token cleared before revocation · local demo restored", tone: "muted" });
    } catch (caught) {
      setGoogleAuthStatus(googleOAuth.current.status());
      const message = caught instanceof Error ? caught.message : "Google access revocation failed.";
      setError(message);
      setStatus("Local credential cleared; verify Google Account permissions");
      record({ title: "Google revocation unconfirmed", detail: message, tone: "muted" });
    } finally {
      setRevokingGoogle(false);
    }
  };

  const loadGoogleSheet = async () => {
    if (connectingGoogle || revokingGoogle) return;
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
      setPlan(null);
      setArtifact(null);
      setArtifactWorkspacePath(null);
      setArtifactFile(null);
      setArtifactSheetChoice("");
      setSource("google");
      setLoadedGoogleTarget({ spreadsheetId: snapshot.spreadsheetId, range: snapshot.range });
      setSpreadsheetId(snapshot.spreadsheetId);
      setRange(snapshot.range);
      setStatus(`Loaded ${snapshot.values.length} rows from ${snapshot.range}`);
      record({
        title: "Google Sheets range read",
        detail: `${snapshot.range} · ${snapshot.values.length} rows · broker attached credential after manifest validation`,
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets read failed.";
      if (/authorization|reconnect/i.test(message)) {
        googleOAuth.current.clear();
        setGoogleAuthStatus(googleOAuth.current.status());
      }
      setError(message);
      setStatus("Connector read failed");
      record({ title: "Connector read blocked", detail: message, tone: "muted" });
    }
  };

  const approveWrite = async () => {
    if (!proposal || committing || connectingGoogle || revokingGoogle) return;
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
      const outcome = await effectExecutor.current.execute(proposal, approval, connector);

      if (outcome.status === "committed") {
        setRows(applySpreadsheetMutationBundle(
          proposal.baseValues,
          proposal.mutations,
          proposal.target.inputMode
        ));
        setProposal(null);
        setPlan(null);
        setStatus(isGoogle
          ? `Updated ${outcome.receipt.providerResult.updatedCells} cells in ${outcome.receipt.providerResult.updatedRange}`
          : source === "artifact" ? "Approved changes applied to the imported working snapshot" : "Approved changes applied to the local demo");
        record({
          title: isGoogle ? "Google Sheets effect committed" : "Local effect committed",
          detail: `${outcome.receipt.receiptId.slice(-12)} · ${proposal.summary.changedCells} cells · ${outcome.receipt.preconditionStrength}`,
          tone: "accent"
        });
      } else if (outcome.status === "conflict") {
        if (outcome.observedValues) setRows(outcome.observedValues);
        else setLoadedGoogleTarget(null);
        setProposal(null);
        setPlan(null);
        setStatus("Write blocked by source conflict");
        setError("The source changed after this proposal was prepared. Review the latest values and prepare a new proposal.");
        record({
          title: "Write blocked: source conflict",
          detail: `${outcome.preconditionStrength} · expected ${outcome.expectedBaseVersion.value.slice(-10)} · observed ${outcome.observedBaseVersion?.value.slice(-10) ?? "provider conflict"}`,
          tone: "muted"
        });
      } else if (outcome.status === "uncertain") {
        setProposal(null);
        setLoadedGoogleTarget(null);
        setStatus("Write outcome uncertain — reconciliation required");
        setError(outcome.reason);
        record({ title: "Write outcome uncertain", detail: "No automatic retry · read the target before another proposal", tone: "muted" });
      } else if (outcome.status === "failed") {
        if (outcome.code === "source_recheck_failed" && /authorization|reconnect/i.test(outcome.reason)) {
          googleOAuth.current.clear();
          setGoogleAuthStatus(googleOAuth.current.status());
        }
        if (!outcome.retryable) setProposal(null);
        setStatus(outcome.retryable ? "Source recheck failed — safe to retry" : "Approved write blocked");
        setError(outcome.reason);
        record({ title: "Approved effect blocked", detail: `${outcome.code} · ${outcome.reason}`, tone: "muted" });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets write failed.";
      setError(message);
      setStatus("Approved effect blocked");
      record({ title: "Approved effect blocked", detail: message, tone: "muted" });
    } finally {
      setCommitting(false);
    }
  };

  const rejectWrite = async () => {
    if (!proposal || committing) return;
    const outcome = await effectExecutor.current.reject(
      proposal,
      decideSpreadsheetEffect(proposal, "reject", "foreground-user")
    );
    if (outcome.status === "rejected") {
      record({ title: "Write proposal rejected", detail: proposal.proposalId.slice(-12), tone: "muted" });
      setProposal(null);
      setStatus("Write proposal rejected; no mutation occurred");
    } else if (outcome.status === "failed") {
      setError(outcome.reason);
      setStatus("Proposal rejection could not be recorded");
    }
  };

  const resetDemo = () => {
    authorityEpoch.current += 1;
    setRows(DEMO_ROWS);
    setProposal(null);
    setPlan(null);
    setArtifact(null);
    setArtifactWorkspacePath(null);
    setArtifactFile(null);
    setArtifactSheetChoice("");
    setSource("demo");
    setLoadedGoogleTarget(null);
    setStatus("Ready");
    setError("");
    setAudit([{ time: "00:00", title: "Local demo loaded", detail: "4 rows · no external request", tone: "muted" }]);
  };

  const importLocalArtifact = async (file: File, sheetName?: string) => {
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
      } catch {
        persistenceWarning = " · OPFS persistence failed; export before closing this tab";
      }
      setRows(snapshot.rows.map((row) => [...row]));
      setArtifact(snapshot.provenance);
      setArtifactWorkspacePath(persistedPath);
      setArtifactFile(file);
      setArtifactSheetChoice(snapshot.provenance.sheetName);
      setPlan(null);
      setSource("artifact");
      setStatus(`Loaded ${snapshot.provenance.rows} rows from ${snapshot.provenance.sheetName}`);
      record({
        title: "Local tabular artifact imported",
        detail: `${snapshot.provenance.sourceName} · ${snapshot.provenance.format.toUpperCase()} · ${snapshot.provenance.rows}×${snapshot.provenance.columns} · sha256 ${snapshot.provenance.sourceSha256.slice(0, 12)} · ${persistedPath ?? "memory only"}${persistenceWarning}`,
        tone: "accent"
      });
      if (snapshot.provenance.warnings.length) {
        record({
          title: "Value-only import boundary",
          detail: snapshot.provenance.warnings.join(" "),
          tone: "muted"
        });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Local tabular artifact import failed.";
      setError(message);
      setStatus("Local artifact import blocked");
      record({ title: "Local artifact import blocked", detail: message, tone: "muted" });
    } finally {
      setImportingArtifact(false);
      if (artifactInput.current) artifactInput.current.value = "";
    }
  };

  const exportWorkingData = async (format: TabularArtifactFormat) => {
    if (exportingArtifact) return;
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
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Artifact export failed.";
      setError(message);
      setStatus("Artifact export blocked");
      record({ title: "Artifact export blocked", detail: message, tone: "muted" });
    } finally {
      setExportingArtifact(false);
    }
  };

  return (
    <main className="operator-app">
      <header className="operator-header">
        <a href={homeUrl} className="operator-brand"><span>WH</span><strong>WasmHatch</strong></a>
        <div className="operator-title">
          <small>Business operator / foundation slice</small>
          <strong>Spreadsheet transformation</strong>
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
          <div className={source === "google" ? "connector-row active static" : "connector-row static"}>
            <Table2 size={16} /><span><strong>Google Sheets</strong><small>{googleConnectionLabel(googleAuthStatus)}</small></span>
            {googleAuthStatus.connected && <Check size={14} />}
          </div>
          <div className="connector-row static planner-connector">
            <Bot size={16} /><span><strong>OpenAI planner</strong><small>Responses API · optional</small></span>
          </div>
          <div className="connector-form planner-credentials">
            <label>Session API key<input type="password" value={plannerApiKey} onChange={(event) => setPlannerApiKey(event.target.value)} autoComplete="off" placeholder="Memory only" aria-label="OpenAI session API key" disabled={committing} /></label>
            <label>Planning model
              <select value={plannerModel} onChange={(event) => setPlannerModel(event.target.value)} aria-label="Planning model" disabled={committing}>
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
              setSpreadsheetId(event.target.value);
              if (source === "google") {
                invalidateProposal("Google spreadsheet target edited");
                setLoadedGoogleTarget(null);
                setStatus("Target changed — read the range again");
              }
            }} placeholder="1abc…" disabled={committing} /></label>
            <label>Range<input value={range} onChange={(event) => {
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
            <p>Requests the sensitive Sheets read/write scope for this foreground session only. The host broker attaches the short-lived token after validating connector operation and exact target. It is never persisted or exposed to connector, model, or script code.</p>
          </div>
          <div className="operator-scope">
            <ShieldCheck size={16} />
            <div><strong>Current boundary</strong><p>Foreground GIS token model. Expiry requires a new user gesture; no refresh token, scheduling, or unattended write.</p></div>
          </div>
        </aside>

        <section className="operator-workbench">
          <div className="operator-panel-heading"><span>Working data</span><small>{rows.length} rows · {Math.max(0, ...rows.map((row) => row.length))} columns{rows.length > TABLE_PREVIEW_ROWS ? ` · previewing ${TABLE_PREVIEW_ROWS}` : ""}</small></div>
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
            <textarea value={task} onChange={(event) => { setTask(event.target.value); setPlan(null); invalidateProposal("task intent edited"); }} aria-label="Business task" disabled={committing} />
            <div className="operator-planner-actions">
              <button onClick={() => void draftWithAI()} disabled={committing || !plannerApiKey.trim() || !task.trim() || planning}>
                {planning ? <RefreshCw size={14} /> : <KeyRound size={14} />}{planning ? "Drafting…" : "Draft with AI"}
              </button>
              <span>Explicitly sends this task and {rows.length} visible rows to OpenAI. Sheets and API credentials are excluded.</span>
            </div>
          </div>

          {plan && (
            <div className="operator-plan" aria-label="AI transformation plan">
              <div><Bot size={15} /><strong>Staged AI plan</strong><small>{plan.model}</small></div>
              <h3>{plan.summary}</h3>
              <p><b>Expected effect</b>{plan.expectedEffect}</p>
              {!!plan.assumptions.length && <p><b>Verify assumptions</b>{plan.assumptions.join(" · ")}</p>}
              {!!plan.warnings.length && <p className="warning"><b>Warnings</b>{plan.warnings.join(" · ")}</p>}
              <footer>Script copied below for inspection. It has not run and no write has occurred.</footer>
            </div>
          )}

          <div className="operator-script">
            <div className="operator-task-label"><span>Sandbox script</span><small>QuickJS · Wasm worker · no fetch or DOM</small></div>
            <textarea value={script} onChange={(event) => { setScript(event.target.value); setPlan(null); invalidateProposal("sandbox script edited"); }} spellCheck={false} aria-label="Sandbox transformation script" disabled={committing} />
            <div className="operator-script-actions">
              <button onClick={() => void runScript()} disabled={committing || connectingGoogle || revokingGoogle || (source === "google" && !loadedGoogleTarget)}><Play size={14} /> Run in Wasm sandbox</button>
              <span>Input and output are JSON-only · 750 ms CPU limit · 32 MB memory limit</span>
            </div>
          </div>
          {error && <p className="operator-error" role="alert">{error}</p>}
        </section>

        <aside className="operator-review" aria-label="Review and audit">
          <div className="operator-panel-heading"><span>Write review</span><small>{changes.length} changes</small></div>
          {proposal ? (
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
            <div className="empty-review"><ShieldCheck size={22} /><strong>No pending write</strong><p>Run the sandbox script to create a cell-level preview. Nothing writes automatically.</p></div>
          )}

          <div className="operator-panel-heading audit-heading"><span>Audit trail</span><small>this tab</small></div>
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
