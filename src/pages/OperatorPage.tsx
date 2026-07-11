import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Database,
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
  diffSpreadsheetRows,
  GoogleSheetsConnector,
  spreadsheetRowsFromBusinessValue,
  type SpreadsheetRows
} from "../lib/spreadsheet";

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

export function OperatorPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const [rows, setRows] = useState<SpreadsheetRows>(DEMO_ROWS);
  const [previewRows, setPreviewRows] = useState<SpreadsheetRows | null>(null);
  const [task, setTask] = useState("Normalize names and regions, convert amounts to numbers, and standardize stages.");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [plan, setPlan] = useState<SpreadsheetPlan | null>(null);
  const [plannerApiKey, setPlannerApiKey] = useState("");
  const [plannerModel, setPlannerModel] = useState(DEFAULT_PLANNER_MODEL);
  const [planning, setPlanning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [source, setSource] = useState<"demo" | "google">("demo");
  const [accessToken, setAccessToken] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [range, setRange] = useState("Sheet1!A1:D20");
  const [audit, setAudit] = useState<AuditEntry[]>([
    { time: "00:00", title: "Local demo loaded", detail: "4 rows · no external request", tone: "muted" }
  ]);

  const changes = useMemo(
    () => previewRows ? diffSpreadsheetRows(rows, previewRows) : [],
    [previewRows, rows]
  );

  const record = (entry: Omit<AuditEntry, "time">) => {
    const elapsed = audit.length.toString().padStart(2, "0");
    setAudit((current) => [...current, { ...entry, time: `00:${elapsed}` }]);
  };

  const runScript = async () => {
    setStatus("Running in Wasm worker…");
    setError("");
    try {
      const result = await runBusinessScriptInWorker(script, rows);
      const nextRows = spreadsheetRowsFromBusinessValue(result.output);
      setPreviewRows(nextRows);
      setStatus(`${diffSpreadsheetRows(rows, nextRows).length} cell changes ready for review`);
      record({
        title: "Sandbox transform completed",
        detail: `${result.inputBytes} B in · ${result.outputBytes} B out · ${Math.round(result.durationMs)} ms`,
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
    setPreviewRows(null);
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

  const loadGoogleSheet = async () => {
    setStatus("Reading Google Sheets…");
    setError("");
    try {
      const connector = new GoogleSheetsConnector(accessToken);
      const snapshot = await connector.read({ spreadsheetId, range });
      setRows(snapshot.values);
      setPreviewRows(null);
      setPlan(null);
      setSource("google");
      setStatus(`Loaded ${snapshot.values.length} rows from ${snapshot.range}`);
      record({
        title: "Google Sheets range read",
        detail: `${snapshot.range} · ${snapshot.values.length} rows · token stayed in connector memory`,
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets read failed.";
      setError(message);
      setStatus("Connector read failed");
      record({ title: "Connector read blocked", detail: message, tone: "muted" });
    }
  };

  const approveWrite = async () => {
    if (!previewRows) return;
    setError("");
    if (source === "demo") {
      setRows(previewRows);
      setPreviewRows(null);
      setPlan(null);
      setStatus("Approved changes applied to the local demo");
      record({ title: "Local write approved", detail: `${changes.length} cells applied`, tone: "accent" });
      return;
    }

    setStatus("Writing approved cells to Google Sheets…");
    try {
      const connector = new GoogleSheetsConnector(accessToken);
      const result = await connector.write({ spreadsheetId, range, values: previewRows });
      setRows(previewRows);
      setPreviewRows(null);
      setPlan(null);
      setStatus(`Updated ${result.updatedCells} cells in ${result.updatedRange}`);
      record({
        title: "Google Sheets write approved",
        detail: `${result.updatedRange} · ${result.updatedCells} cells`,
        tone: "accent"
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google Sheets write failed.";
      setError(message);
      setStatus("Connector write failed");
      record({ title: "Connector write failed", detail: message, tone: "muted" });
    }
  };

  const resetDemo = () => {
    setRows(DEMO_ROWS);
    setPreviewRows(null);
    setPlan(null);
    setSource("demo");
    setStatus("Ready");
    setError("");
    setAudit([{ time: "00:00", title: "Local demo loaded", detail: "4 rows · no external request", tone: "muted" }]);
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
        <aside className="operator-connectors" aria-label="Connectors">
          <div className="operator-panel-heading"><span>Connectors</span><small>credentials stay here</small></div>
          <button className={source === "demo" ? "connector-row active" : "connector-row"} onClick={resetDemo}>
            <Database size={16} /><span><strong>Local demo</strong><small>No network</small></span><Check size={14} />
          </button>
          <div className={source === "google" ? "connector-row active static" : "connector-row static"}>
            <Table2 size={16} /><span><strong>Google Sheets</strong><small>OAuth access token</small></span>
          </div>
          <div className="connector-row static planner-connector">
            <Bot size={16} /><span><strong>OpenAI planner</strong><small>Responses API · optional</small></span>
          </div>
          <div className="connector-form planner-credentials">
            <label>Session API key<input type="password" value={plannerApiKey} onChange={(event) => setPlannerApiKey(event.target.value)} autoComplete="off" placeholder="Memory only" aria-label="OpenAI session API key" /></label>
            <label>Planning model
              <select value={plannerModel} onChange={(event) => setPlannerModel(event.target.value)} aria-label="Planning model">
                <option value="gpt-5.6-luna">GPT-5.6 Luna · efficient</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra · balanced</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol · highest capability</option>
              </select>
            </label>
            <p>The key stays in this tab and is used only in the Authorization header. It never enters spreadsheet data, the model prompt, or the Wasm worker.</p>
          </div>
          <div className="connector-form">
            <label>Development access token<input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="off" placeholder="Memory only" /></label>
            <label>Spreadsheet ID<input value={spreadsheetId} onChange={(event) => setSpreadsheetId(event.target.value)} placeholder="1abc…" /></label>
            <label>Range<input value={range} onChange={(event) => setRange(event.target.value)} placeholder="Sheet1!A1:D20" /></label>
            <button onClick={() => void loadGoogleSheet()} disabled={!accessToken.trim() || !spreadsheetId.trim() || !range.trim()}>
              <RefreshCw size={13} /> Read range
            </button>
            <p>The token is held by the connector in this tab. It is never sent to the model or sandbox script.</p>
          </div>
          <div className="operator-scope">
            <ShieldCheck size={16} />
            <div><strong>Current boundary</strong><p>Foreground session only. No scheduling, refresh-token storage, or unattended writes.</p></div>
          </div>
        </aside>

        <section className="operator-workbench">
          <div className="operator-panel-heading"><span>Working data</span><small>{rows.length} rows · {Math.max(0, ...rows.map((row) => row.length))} columns</small></div>
          <div className="operator-table-wrap">
            <table className="operator-table">
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th>{rowIndex + 1}</th>
                    {row.map((cell, columnIndex) => <td key={columnIndex}>{displayCell(cell)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="operator-task">
            <div className="operator-task-label"><Sparkles size={14} /><span>Task intent</span><small>AI may propose; only you can run and write</small></div>
            <textarea value={task} onChange={(event) => { setTask(event.target.value); setPlan(null); setPreviewRows(null); }} aria-label="Business task" />
            <div className="operator-planner-actions">
              <button onClick={() => void draftWithAI()} disabled={!plannerApiKey.trim() || !task.trim() || planning}>
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
            <textarea value={script} onChange={(event) => { setScript(event.target.value); setPlan(null); setPreviewRows(null); }} spellCheck={false} aria-label="Sandbox transformation script" />
            <div className="operator-script-actions">
              <button onClick={() => void runScript()}><Play size={14} /> Run in Wasm sandbox</button>
              <span>Input and output are JSON-only · 750 ms CPU limit · 32 MB memory limit</span>
            </div>
          </div>
          {error && <p className="operator-error" role="alert">{error}</p>}
        </section>

        <aside className="operator-review" aria-label="Review and audit">
          <div className="operator-panel-heading"><span>Write review</span><small>{changes.length} changes</small></div>
          {previewRows ? (
            <div className="change-review">
              <div className="change-summary"><UploadCloud size={18} /><div><strong>Explicit approval required</strong><p>{changes.length} cell changes will be written to {source === "google" ? range : "the local demo"}.</p></div></div>
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
              <button className="approve-write" onClick={() => void approveWrite()} disabled={!changes.length}>
                <Check size={15} /> Approve and {source === "google" ? "write range" : "apply locally"}
              </button>
              <button className="reject-write" onClick={() => setPreviewRows(null)}>Reject preview</button>
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
