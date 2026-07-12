import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Download,
  FileDiff,
  FileCode2,
  FileText,
  FolderGit2,
  GitFork,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Play,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { createZipArchive, fetchGitHubRepository, readZipArchive } from "../lib/archive";
import {
  runAnthropicAgent,
  type AgentBudgetSnapshot,
  type FileProposal,
  type ModelEgressEvent
} from "../lib/agent";
import { createReadableDiff } from "../lib/diff";
import { buildWorkspacePatch } from "../lib/patch";
import { normalizeGitHubIssueUrl } from "../lib/share";
import {
  createWorkspaceStore,
  formatBytes,
  inspectBrowserStorage,
  measureWorkspaceUsage,
  requestPersistentStorage,
  sampleWorkspace,
  type BrowserStorageStatus,
  type WorkspaceFile,
  type WorkspaceStore,
  type WorkspaceUsage
} from "../lib/workspace";

const demoTask = "Make greet handle an empty or whitespace-only name by greeting ‘friend’. Keep the change small.";
const samplePaths = new Set(sampleWorkspace.map((file) => file.path));

function isSampleFileList(paths: string[]) {
  return paths.length === samplePaths.size && paths.every((path) => samplePaths.has(path));
}

function fileIcon(path: string) {
  return path.endsWith(".md") ? <FileText size={15} /> : <FileCode2 size={15} />;
}

export function WorkspacePage() {
  const searchParams = new URLSearchParams(location.search);
  const issueUrl = normalizeGitHubIssueUrl(searchParams.get("issue") || "");
  const issueNumber = issueUrl.split("/").pop() || "";
  const linkedRepository = searchParams.get("repo") || "";
  const store = useRef<WorkspaceStore>(createWorkspaceStore());
  const initialization = useRef<Promise<{
    files: string[];
    selectedPath: string;
    content: string;
  }> | null>(null);
  const fileSelection = useRef(0);
  const archiveInput = useRef<HTMLInputElement>(null);
  const agentAbort = useRef<AbortController | null>(null);
  const storageDialog = useRef<HTMLDialogElement>(null);
  const storageTrigger = useRef<HTMLButtonElement>(null);
  const storageCancel = useRef<HTMLButtonElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [editor, setEditor] = useState("");
  const [savedEditor, setSavedEditor] = useState("");
  const [task, setTask] = useState(searchParams.get("task") || demoTask);
  const [repo, setRepo] = useState(linkedRepository);
  const [repoRef, setRepoRef] = useState(searchParams.get("ref") || "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [status, setStatus] = useState("Opening workspace");
  const [answer, setAnswer] = useState(
    linkedRepository
      ? "Import the pinned source, then edit files manually or connect Claude for a focused change."
      : "Run the local demo or connect Claude to inspect this workspace."
  );
  const [proposal, setProposal] = useState<FileProposal | null>(null);
  const [proposalBefore, setProposalBefore] = useState("");
  const [proposalBaseExists, setProposalBaseExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [patchExported, setPatchExported] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState(!linkedRepository);
  const [storageOpen, setStorageOpen] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageUsage, setStorageUsage] = useState<WorkspaceUsage | null>(null);
  const [modelEgress, setModelEgress] = useState<ModelEgressEvent[]>([]);
  const [agentBudget, setAgentBudget] = useState<AgentBudgetSnapshot | null>(null);
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageStatus | null>(null);
  const storageBackend = store.current.backend;

  const persistCurrentEdit = async (announce = false) => {
    if (!selectedPath || editor === savedEditor) return;
    await store.current.writeFile(selectedPath, editor);
    setPatchExported(false);
    setSavedEditor(editor);
    if (announce) setNotice(`Saved ${selectedPath} locally.`);
  };

  const confirmDiscardForImport = () => (
    !selectedPath || editor === savedEditor || window.confirm(
      "Importing replaces the current workspace. Discard the unsaved edit and continue?"
    )
  );

  const refreshFiles = async (preferredPath?: string) => {
    const nextFiles = await store.current.listFiles();
    setFiles(nextFiles);
    const nextPath = preferredPath && nextFiles.includes(preferredPath)
      ? preferredPath
      : selectedPath && nextFiles.includes(selectedPath)
        ? selectedPath
        : nextFiles[0] || "";
    if (nextPath) await selectFile(nextPath, false);
  };

  const selectFile = async (path: string, saveCurrent = true) => {
    const selection = ++fileSelection.current;
    setFileLoading(true);
    try {
      if (saveCurrent) await persistCurrentEdit();
      const content = await store.current.readFile(path);
      if (selection !== fileSelection.current) return;
      setSelectedPath(path);
      setEditor(content);
      setSavedEditor(content);
    } catch (error) {
      if (selection === fileSelection.current) {
        setNotice(error instanceof Error ? error.message : "File could not be opened.");
      }
    } finally {
      if (selection === fileSelection.current) setFileLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void inspectBrowserStorage().then((result) => {
      if (active) setBrowserStorage(result);
    });
    initialization.current ??= (async () => {
      let current = await store.current.listFiles();
      if (!current.length) {
        await store.current.replaceAll(sampleWorkspace);
        current = await store.current.listFiles();
      } else if (!(await store.current.listBaselineFiles()).length) {
        const migratedFiles = await Promise.all(
          current.map(async (path) => ({ path, content: await store.current.readFile(path) }))
        );
        await store.current.replaceBaseline(migratedFiles);
      }
      const initialPath = current[0] || "";
      const content = initialPath ? await store.current.readFile(initialPath) : "";
      return { files: current, selectedPath: initialPath, content };
    })();
    void initialization.current
      .then((result) => {
        if (!active) return;
        setFiles(result.files);
        setSelectedPath(result.selectedPath);
        setEditor(result.content);
        setSavedEditor(result.content);
        setDemoAvailable(isSampleFileList(result.files) && !linkedRepository);
        setWorkspaceReady(true);
        setFileLoading(false);
        setStatus("Ready");
      })
      .catch((error) => {
        if (!active) return;
        setNotice(error instanceof Error ? error.message : "Workspace failed to load.");
        setStatus("Storage unavailable");
        setFileLoading(false);
        setAnswer("Browser storage could not be initialized. Check site-data permissions or use a supported browser.");
      });
    return () => {
      active = false;
      agentAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!storageOpen) return;
    const dialog = storageDialog.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => storageTrigger.current?.focus();
  }, [storageOpen]);

  useEffect(() => {
    if (storageOpen && !storageBusy) storageCancel.current?.focus();
  }, [storageOpen, storageBusy]);

  useEffect(() => {
    if (!selectedPath || editor === savedEditor) return;
    const warnAboutUnsavedEdit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedEdit);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedEdit);
  }, [editor, savedEditor, selectedPath]);

  const saveEditor = async () => {
    try {
      await persistCurrentEdit(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "File could not be saved.");
    }
  };

  const importRepository = async () => {
    if (!workspaceReady || !repo.trim() || !confirmDiscardForImport()) return;
    setBusy(true);
    setStatus("Importing from GitHub");
    try {
      const imported = await fetchGitHubRepository(repo, repoRef.trim() || "HEAD");
      if (!imported.length) throw new Error("No supported text files were found.");
      await store.current.replaceAll(imported);
      setPatchExported(false);
      setDemoAvailable(false);
      setProposal(null);
      setModelEgress([]);
      setAgentBudget(null);
      await refreshFiles(imported[0].path);
      setAnswer(`Imported ${imported.length} text files${repoRef.trim() ? ` at ${repoRef.trim()}` : ""}. Edit manually or connect Claude when you are ready.`);
      setNotice("Repository imported into browser storage.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "GitHub import failed.");
    } finally {
      setBusy(false);
      setStatus("Ready");
    }
  };

  const importArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !workspaceReady) {
      event.target.value = "";
      return;
    }
    if (!confirmDiscardForImport()) {
      event.target.value = "";
      return;
    }
    setBusy(true);
    setStatus("Importing archive");
    try {
      const imported = readZipArchive(new Uint8Array(await file.arrayBuffer()));
      if (!imported.length) throw new Error("No supported text files were found.");
      await store.current.replaceAll(imported);
      setPatchExported(false);
      setDemoAvailable(false);
      setProposal(null);
      setModelEgress([]);
      setAgentBudget(null);
      await refreshFiles(imported[0].path);
      setNotice(`Imported ${imported.length} text files from ${file.name}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Archive import failed.");
    } finally {
      event.target.value = "";
      setBusy(false);
      setStatus("Ready");
    }
  };

  const download = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportWorkspace = async () => {
    const workspaceFiles: WorkspaceFile[] = await Promise.all(
      files.map(async (path) => ({
        path,
        content: path === selectedPath && editor !== savedEditor
          ? editor
          : await store.current.readFile(path)
      }))
    );
    const zip = createZipArchive(workspaceFiles);
    const blob = new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer], {
      type: "application/zip"
    });
    download(blob, "wasmhatch-workspace.zip");
    setNotice("Workspace exported as a zip archive.");
  };

  const openStorageManager = async () => {
    setStorageOpen(true);
    setStorageBusy(true);
    try {
      const [usage, status] = await Promise.all([
        measureWorkspaceUsage(store.current),
        inspectBrowserStorage()
      ]);
      setStorageUsage(usage);
      setBrowserStorage(status);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Storage usage could not be measured.");
    } finally {
      setStorageBusy(false);
    }
  };

  const requestPersistence = async () => {
    setStorageBusy(true);
    try {
      const granted = await requestPersistentStorage();
      setBrowserStorage(await inspectBrowserStorage());
      setNotice(
        granted === null
          ? "Persistent storage requests are unavailable in this browser."
          : granted
            ? "Persistent browser storage was granted for this origin."
            : "The browser kept this origin on best-effort storage. Keep an exported copy."
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Persistent storage could not be requested.");
    } finally {
      setStorageBusy(false);
    }
  };

  const clearWorkspace = async (exportFirst: boolean) => {
    setStorageBusy(true);
    try {
      if (exportFirst) await exportWorkspace();
      await store.current.clear();
      setFiles([]);
      setSelectedPath("");
      setEditor("");
      setSavedEditor("");
      setProposal(null);
      setProposalBefore("");
      setPatchExported(false);
      setDemoAvailable(false);
      setModelEgress([]);
      setAgentBudget(null);
      setStorageUsage(null);
      setStorageOpen(false);
      setAnswer("Workspace cleared. Import a repository or zip archive to continue.");
      setStatus("Workspace empty");
      setNotice(
        exportFirst
          ? "Workspace exported, then project files and baseline were cleared."
          : "Project files and baseline were cleared from browser storage."
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Workspace could not be cleared.");
    } finally {
      setStorageBusy(false);
    }
  };

  const exportPatch = async () => {
    try {
      await persistCurrentEdit();
      const { patch, changedFileCount } = await buildWorkspacePatch(store.current);
      if (!patch) {
        setNotice("No changes from the imported baseline to export.");
        return;
      }
      download(new Blob([`${patch}\n`], { type: "text/x-diff;charset=utf-8" }), "wasmhatch.patch");
      setPatchExported(true);
      setNotice(
        `Exported ${changedFileCount} changed file(s) as a patch.${issueNumber ? ` Return to Issue #${issueNumber} when it is ready.` : ""}`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Patch could not be exported.");
    }
  };

  const stageProposal = async (next: FileProposal) => {
    let before = "";
    let baseExists = true;
    try { before = await store.current.readFile(next.path); } catch { baseExists = false; }
    setProposalBefore(before);
    setProposalBaseExists(baseExists);
    setProposal(next);
  };

  const runDemo = async () => {
    if (!demoAvailable) return;
    setBusy(true);
    setProposal(null);
    try {
      await persistCurrentEdit();
      setStatus("Reading src/greet.ts");
      setAnswer("Inspecting the smallest relevant surface…");
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      setStatus("Preparing a reviewable patch");
      await stageProposal({
        path: "src/greet.ts",
        rationale: "Trim the input and use a friendly fallback without changing the public API.",
        content: `export function greet(name: string): string {\n  const cleanName = name.trim();\n  return \`Hello, \${cleanName || "friend"}!\`;\n}\n`
      });
      setAnswer("I found one focused edge case and staged a complete-file patch. Nothing has been written yet.");
      setStatus("1 change awaiting review");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Local demo failed.");
      setStatus("Demo stopped");
    } finally {
      setBusy(false);
    }
  };

  const runAgent = async () => {
    if (!apiKey.trim()) {
      setNotice("Enter a session-only Anthropic API key, or run the local demo.");
      return;
    }
    setBusy(true);
    setAgentRunning(true);
    setProposal(null);
    setModelEgress([]);
    setAgentBudget(null);
    setAnswer("");
    const controller = new AbortController();
    agentAbort.current = controller;
    let receivedProposal = false;
    let proposalStage: Promise<void> | null = null;
    try {
      await persistCurrentEdit();
      const response = await runAnthropicAgent({
        apiKey,
        model,
        task,
        workspace: store.current,
        onStatus: setStatus,
        onProposal: (next) => {
          receivedProposal = true;
          proposalStage = stageProposal(next);
        },
        onEgress: (event) => setModelEgress((current) => [...current, event]),
        onBudget: setAgentBudget,
        signal: controller.signal
      });
      if (proposalStage) await proposalStage;
      setAnswer(response);
      setStatus(receivedProposal ? "1 change awaiting review" : "Agent finished");
    } catch (error) {
      if (error instanceof Error && error.message === "Agent run cancelled.") {
        setAnswer("Agent run cancelled. The workspace was not changed.");
        setStatus("Agent cancelled");
      } else {
        setNotice(error instanceof Error ? error.message : "Agent run failed.");
        setStatus("Agent stopped");
      }
    } finally {
      if (agentAbort.current === controller) agentAbort.current = null;
      setAgentRunning(false);
      setBusy(false);
    }
  };

  const cancelAgent = () => {
    if (!agentAbort.current) return;
    setStatus("Stopping agent");
    agentAbort.current.abort();
  };

  const acceptProposal = async () => {
    if (!proposal) return;
    try {
      let current = "";
      let currentExists = true;
      try { current = await store.current.readFile(proposal.path); } catch { currentExists = false; }
      const dirtyProposalFile = proposal.path === selectedPath && editor !== savedEditor;
      if (
        dirtyProposalFile ||
        currentExists !== proposalBaseExists ||
        current !== proposalBefore
      ) {
        setNotice("The file changed after this proposal was prepared. Review the newer edit, then prepare a new proposal.");
        setStatus("Proposal conflict");
        return;
      }
      await store.current.writeFile(proposal.path, proposal.content);
      setPatchExported(false);
      await refreshFiles(proposal.path);
      setNotice(`Applied ${proposal.path}.`);
      setProposal(null);
      setStatus("Change applied locally");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Proposed change could not be applied.");
    }
  };

  return (
    <main className="workspace-app">
      <header className="workspace-header">
        <a href={import.meta.env.BASE_URL} className="workspace-brand"><span>WH</span><strong>WasmHatch</strong></a>
        <div className="workspace-title"><FolderGit2 size={15} /> browser-workspace <ChevronRight size={13} /> <b>{selectedPath || "empty"}</b></div>
        <div className="workspace-state"><i /> {status}</div>
        <button className="icon-label-button" onClick={() => void exportPatch()} disabled={!workspaceReady || busy}><FileDiff size={15} /> Patch</button>
        <button className="icon-label-button" onClick={() => void exportWorkspace()} disabled={!workspaceReady || busy}><Download size={15} /> Zip</button>
        <a className="icon-button" href="https://github.com/haya-inc/wasmhatch" aria-label="Open GitHub"><GitFork size={18} /></a>
      </header>

      <div className="workspace-layout">
        <aside className="file-panel">
          <div className="panel-heading"><span>Workspace</span><small>{files.length} files</small></div>
          <div className="import-form">
            <label htmlFor="repo">Public GitHub repository</label>
            <div><input id="repo" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repository" /><button onClick={() => void importRepository()} disabled={!workspaceReady || busy} aria-label="Import repository"><ArrowLeft className="import-arrow" size={16} /></button></div>
            <label htmlFor="repo-ref">Git ref <span>optional</span></label>
            <input id="repo-ref" className="ref-input" value={repoRef} onChange={(event) => setRepoRef(event.target.value)} placeholder="branch, tag, or commit" />
            <button className="archive-button" onClick={() => archiveInput.current?.click()} disabled={!workspaceReady || busy}><Upload size={14} /> Import zip archive</button>
            <input ref={archiveInput} type="file" accept=".zip,application/zip" hidden disabled={!workspaceReady || busy} onChange={(event) => void importArchive(event)} />
          </div>
          <nav className="file-list" aria-label="Workspace files">
            {files.map((path) => (
              <button key={path} className={path === selectedPath ? "active" : ""} onClick={() => void selectFile(path)} disabled={busy || fileLoading}>
                {fileIcon(path)}<span>{path}</span>{proposal?.path === path && <i />}
              </button>
            ))}
          </nav>
          <div className={`storage-note${storageBackend === "local-storage" ? " fallback" : ""}`}>
            <span>{storageBackend === "opfs" ? "OPFS" : "LOCAL"}</span>
            <p>
              {storageBackend === "opfs"
                ? "Files persist in browser-managed storage. Export anything you cannot afford to lose."
                : "OPFS is unavailable. Using the smaller localStorage fallback; export a copy early."}
            </p>
            <button ref={storageTrigger} onClick={() => void openStorageManager()} disabled={!workspaceReady || busy} aria-label="Manage browser storage"><HardDrive size={14} /> Manage</button>
          </div>
        </aside>

        <section className="editor-panel" aria-label="File editor">
          <div className="editor-tabs">
            <span className="active">{selectedPath || "No file"}{editor !== savedEditor && <i />}</span>
            <button disabled={!workspaceReady || busy || fileLoading || !selectedPath || editor === savedEditor} onClick={() => void saveEditor()}><Save size={14} /> Save</button>
          </div>
          <textarea
            className="code-editor"
            aria-label="Code editor"
            spellCheck={false}
            disabled={!workspaceReady || busy || fileLoading}
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
          <div className="editor-status"><span>UTF-8</span><span>Spaces: 2</span><span>{editor.split("\n").length} lines</span></div>
        </section>

        <aside className="agent-panel">
          <div className="agent-heading"><div><Bot size={18} /><span>Agent</span></div><small>BYOK · local tools</small></div>
          <div className="agent-scroll">
            {issueUrl && (
              <section className={`issue-context${patchExported ? " patch-exported" : ""}`} aria-label="Contribution target">
                <div><span>Contribution target</span><small>{repo || "GitHub"}</small></div>
                <a href={issueUrl} target="_blank" rel="noreferrer">
                  <GitFork size={14} /> Issue #{issueNumber} <ChevronRight size={13} />
                </a>
                <p>
                  {patchExported
                    ? "Patch downloaded. Apply it in a local branch, run the repository checks, then return here to discuss or open a pull request."
                    : "Keep the acceptance criteria open while you work. Export Patch when the change is ready for local checks and a pull request."}
                </p>
              </section>
            )}
            <div className="agent-intro"><Sparkles size={18} /><p>{answer}</p></div>

            <section className="egress-ledger" aria-label="Model egress ledger">
              <div className="egress-heading">
                <span><ShieldCheck size={14} /> Model egress</span>
                <small>{modelEgress.length ? `${modelEgress.length} record${modelEgress.length === 1 ? "" : "s"}` : "Nothing sent"}</small>
              </div>
              {modelEgress.length ? (
                <ol>
                  {modelEgress.map((event, index) => (
                    <li key={`${event.kind}-${index}`}>
                      <div>
                        <strong>
                          {event.kind === "task"
                            ? "Task prompt"
                            : event.kind === "file-list"
                              ? "Workspace file list"
                              : event.kind === "file-read"
                                ? event.path
                                : "Compacted context"}
                        </strong>
                        <span>{formatBytes(event.bytes)}</span>
                      </div>
                      {event.kind === "file-list" && (
                        <p>{event.paths.length ? event.paths.join(", ") : "No accessible paths"}{event.protectedPaths ? ` · ${event.protectedPaths} protected hidden` : ""}</p>
                      )}
                      {event.kind === "file-read" && (
                        <p>Lines {event.startLine}–{event.endLine} of {event.totalLines}{event.truncated ? " · more available" : ""}</p>
                      )}
                      {event.kind === "compaction" && <p>{event.toolCalls} completed tool call(s) summarized without file content.</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>Task text and tool-requested project data appear here when attached to a model request.</p>
              )}
              {agentBudget && (
                <div className="agent-budget" aria-label="Agent request budget">
                  <div><span>Requests</span><strong>{agentBudget.requests} / {agentBudget.requestLimit}</strong></div>
                  <div><span>Payload</span><strong>{formatBytes(agentBudget.requestBytes)} / {formatBytes(agentBudget.requestByteLimit)}</strong></div>
                  <div><span>Provider tokens</span><strong>{agentBudget.inputTokens.toLocaleString()} / {agentBudget.inputTokenLimit.toLocaleString()} in · {agentBudget.outputTokens.toLocaleString()} / {agentBudget.outputTokenLimit.toLocaleString()} out</strong></div>
                  {agentBudget.compactedToolCalls > 0 && <p>{agentBudget.compactedToolCalls} earlier tool call(s) compacted.</p>}
                </div>
              )}
              <footer>Common credential paths stay local. First attachments appear above; repeated history counts toward 500 KB. Runs stop at 8 requests, 120K input tokens, or 8K output tokens.</footer>
            </section>

            {proposal && (
              <section className="proposal" aria-label="Proposed change">
                <div className="proposal-heading"><span>Proposed change</span><strong>1 file</strong></div>
                <p>{proposal.rationale}</p>
                <pre>{createReadableDiff(proposal.path, proposalBefore, proposal.content)}</pre>
                <div className="proposal-actions">
                  <button className="accept" onClick={() => void acceptProposal()}><Check size={15} /> Apply change</button>
                  <button onClick={() => setProposal(null)}><X size={15} /> Reject</button>
                </div>
              </section>
            )}

            <div className="credentials">
              <label htmlFor="api-key"><KeyRound size={14} /> Anthropic API key <span>session only</span></label>
              <input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-ant-…" autoComplete="off" />
              <input aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} />
              <p>The key remains in this tab’s memory. Browser BYOK still requires trusting this application.</p>
            </div>
          </div>

          <div className="agent-composer">
            <label htmlFor="task">Task</label>
            <textarea id="task" value={task} onChange={(event) => setTask(event.target.value)} />
            <div>
              {demoAvailable && (
                <button className="demo-button" onClick={() => void runDemo()} disabled={!workspaceReady || busy}><Play size={14} /> Local demo</button>
              )}
              {agentRunning ? (
                <button className="stop-button" onClick={cancelAgent}><X size={15} /> Stop agent</button>
              ) : (
                <button className="run-button" onClick={() => void runAgent()} disabled={!workspaceReady || busy || !task.trim()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Run with Claude
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>

      {storageOpen && (
        <dialog
          ref={storageDialog}
          className="storage-dialog"
          aria-labelledby="storage-dialog-title"
          aria-describedby="storage-dialog-copy storage-dialog-warning"
          aria-busy={storageBusy}
          onCancel={(event) => {
            event.preventDefault();
            if (!storageBusy) setStorageOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !storageBusy) {
              event.preventDefault();
              setStorageOpen(false);
            }
          }}
        >
            <div className="storage-dialog-heading">
              <div><HardDrive size={17} /><h2 id="storage-dialog-title">Browser storage</h2></div>
              <button onClick={() => setStorageOpen(false)} disabled={storageBusy} aria-label="Close storage manager"><X size={16} /></button>
            </div>
            <p id="storage-dialog-copy" className="storage-dialog-copy">WasmHatch stores both your working files and an import baseline in this browser.</p>
            <div className={`storage-capabilities${storageBackend === "local-storage" ? " fallback" : ""}`} role="status">
              <div><span>Backend</span><strong>{storageBackend === "opfs" ? "Origin private file system" : "localStorage fallback"}</strong></div>
              <div>
                <span>Durability</span>
                <strong>
                  {browserStorage?.persistence === "persistent"
                    ? "Persistent"
                    : browserStorage?.persistence === "best-effort"
                      ? "Best effort"
                      : "Unavailable"}
                </strong>
              </div>
            </div>
            <dl className="storage-usage" aria-label="Workspace storage usage">
              <div><dt>Working files</dt><dd>{storageUsage ? formatBytes(storageUsage.workingBytes) : "Measuring…"}</dd></div>
              <div><dt>Patch baseline</dt><dd>{storageUsage ? formatBytes(storageUsage.baselineBytes) : "Measuring…"}</dd></div>
              <div><dt>Total content</dt><dd>{storageUsage ? formatBytes(storageUsage.totalBytes) : "Measuring…"}</dd></div>
              {browserStorage?.originUsageBytes !== null && browserStorage?.originUsageBytes !== undefined && (
                <div>
                  <dt>Whole origin</dt>
                  <dd>
                    {formatBytes(browserStorage.originUsageBytes)}
                    {browserStorage.quotaBytes ? ` / ${formatBytes(browserStorage.quotaBytes)}` : ""}
                  </dd>
                </div>
              )}
            </dl>
            <div id="storage-dialog-warning" className="storage-warning">
              <Trash2 size={16} />
              <p>Clearing removes both copies from this browser. This cannot be undone. The built-in sample may appear again on your next visit.</p>
            </div>
            <div className="storage-dialog-actions">
              {browserStorage?.persistenceRequestAvailable && browserStorage.persistence !== "persistent" && (
                <button className="persist-storage" onClick={() => void requestPersistence()} disabled={storageBusy}><ShieldCheck size={15} /> Request persistence</button>
              )}
              <button className="export-clear" onClick={() => void clearWorkspace(true)} disabled={storageBusy || files.length === 0}><Download size={15} /> Export zip &amp; clear</button>
              <button className="clear-only" onClick={() => void clearWorkspace(false)} disabled={storageBusy || files.length === 0}><Trash2 size={15} /> Clear without export</button>
              <button ref={storageCancel} onClick={() => setStorageOpen(false)} disabled={storageBusy}>Cancel</button>
            </div>
        </dialog>
      )}

      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>
  );
}
