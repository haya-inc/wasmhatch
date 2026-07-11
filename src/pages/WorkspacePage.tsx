import { ChangeEvent, useEffect, useRef, useState } from "react";
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
  KeyRound,
  LoaderCircle,
  Play,
  Save,
  Sparkles,
  Upload,
  X
} from "lucide-react";
import { createZipArchive, fetchGitHubRepository, readZipArchive } from "../lib/archive";
import { runAnthropicAgent, type FileProposal } from "../lib/agent";
import { createReadableDiff } from "../lib/diff";
import { buildWorkspacePatch } from "../lib/patch";
import {
  createWorkspaceStore,
  sampleWorkspace,
  type WorkspaceFile,
  type WorkspaceStore
} from "../lib/workspace";

const demoTask = "Make greet handle an empty or whitespace-only name by greeting ‘friend’. Keep the change small.";

function fileIcon(path: string) {
  return path.endsWith(".md") ? <FileText size={15} /> : <FileCode2 size={15} />;
}

export function WorkspacePage() {
  const store = useRef<WorkspaceStore>(createWorkspaceStore());
  const initialization = useRef<Promise<{
    files: string[];
    selectedPath: string;
    content: string;
  }> | null>(null);
  const archiveInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [editor, setEditor] = useState("");
  const [savedEditor, setSavedEditor] = useState("");
  const [task, setTask] = useState(new URLSearchParams(location.search).get("task") || demoTask);
  const [repo, setRepo] = useState(new URLSearchParams(location.search).get("repo") || "");
  const [repoRef, setRepoRef] = useState(new URLSearchParams(location.search).get("ref") || "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [status, setStatus] = useState("Ready");
  const [answer, setAnswer] = useState("Run the local demo or connect Claude to inspect this workspace.");
  const [proposal, setProposal] = useState<FileProposal | null>(null);
  const [proposalBefore, setProposalBefore] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refreshFiles = async (preferredPath?: string) => {
    const nextFiles = await store.current.listFiles();
    setFiles(nextFiles);
    const nextPath = preferredPath && nextFiles.includes(preferredPath)
      ? preferredPath
      : selectedPath && nextFiles.includes(selectedPath)
        ? selectedPath
        : nextFiles[0] || "";
    if (nextPath) await selectFile(nextPath);
  };

  const selectFile = async (path: string) => {
    const content = await store.current.readFile(path);
    setSelectedPath(path);
    setEditor(content);
    setSavedEditor(content);
  };

  useEffect(() => {
    let active = true;
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
      })
      .catch((error) => {
        if (active) setNotice(error instanceof Error ? error.message : "Workspace failed to load.");
      });
    return () => { active = false; };
  }, []);

  const saveEditor = async () => {
    if (!selectedPath) return;
    await store.current.writeFile(selectedPath, editor);
    setSavedEditor(editor);
    setNotice(`Saved ${selectedPath} locally.`);
  };

  const importRepository = async () => {
    if (!repo.trim()) return;
    setBusy(true);
    setStatus("Importing from GitHub");
    try {
      const imported = await fetchGitHubRepository(repo, repoRef.trim() || "HEAD");
      if (!imported.length) throw new Error("No supported text files were found.");
      await store.current.replaceAll(imported);
      setProposal(null);
      await refreshFiles(imported[0].path);
      setAnswer(`Imported ${imported.length} text files${repoRef.trim() ? ` at ${repoRef.trim()}` : ""}. Describe a focused change when you are ready.`);
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
    if (!file) return;
    try {
      const imported = readZipArchive(new Uint8Array(await file.arrayBuffer()));
      if (!imported.length) throw new Error("No supported text files were found.");
      await store.current.replaceAll(imported);
      setProposal(null);
      await refreshFiles(imported[0].path);
      setNotice(`Imported ${imported.length} text files from ${file.name}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Archive import failed.");
    } finally {
      event.target.value = "";
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
      files.map(async (path) => ({ path, content: await store.current.readFile(path) }))
    );
    const zip = createZipArchive(workspaceFiles);
    const blob = new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer], {
      type: "application/zip"
    });
    download(blob, "wasmhatch-workspace.zip");
    setNotice("Workspace exported as a zip archive.");
  };

  const exportPatch = async () => {
    const { patch, changedFileCount } = await buildWorkspacePatch(store.current);
    if (!patch) {
      setNotice("No changes from the imported baseline to export.");
      return;
    }
    download(new Blob([`${patch}\n`], { type: "text/x-diff;charset=utf-8" }), "wasmhatch.patch");
    setNotice(`Exported ${changedFileCount} changed file(s) as a patch.`);
  };

  const stageProposal = async (next: FileProposal) => {
    let before = "";
    try { before = await store.current.readFile(next.path); } catch { /* New file. */ }
    setProposalBefore(before);
    setProposal(next);
  };

  const runDemo = async () => {
    setBusy(true);
    setProposal(null);
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
    setBusy(false);
  };

  const runAgent = async () => {
    if (!apiKey.trim()) {
      setNotice("Enter a session-only Anthropic API key, or run the local demo.");
      return;
    }
    setBusy(true);
    setProposal(null);
    setAnswer("");
    try {
      const response = await runAnthropicAgent({
        apiKey,
        model,
        task,
        workspace: store.current,
        onStatus: setStatus,
        onProposal: (next) => void stageProposal(next)
      });
      setAnswer(response);
      setStatus("Agent finished");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Agent run failed.");
      setStatus("Agent stopped");
    } finally {
      setBusy(false);
    }
  };

  const acceptProposal = async () => {
    if (!proposal) return;
    await store.current.writeFile(proposal.path, proposal.content);
    await refreshFiles(proposal.path);
    setNotice(`Applied ${proposal.path}.`);
    setProposal(null);
    setStatus("Change applied locally");
  };

  return (
    <main className="workspace-app">
      <header className="workspace-header">
        <a href={import.meta.env.BASE_URL} className="workspace-brand"><span>WH</span><strong>WasmHatch</strong></a>
        <div className="workspace-title"><FolderGit2 size={15} /> browser-workspace <ChevronRight size={13} /> <b>{selectedPath || "loading"}</b></div>
        <div className="workspace-state"><i /> {status}</div>
        <button className="icon-label-button" onClick={() => void exportPatch()}><FileDiff size={15} /> Patch</button>
        <button className="icon-label-button" onClick={() => void exportWorkspace()}><Download size={15} /> Zip</button>
        <a className="icon-button" href="https://github.com/haya-inc/wasmhatch" aria-label="Open GitHub"><GitFork size={18} /></a>
      </header>

      <div className="workspace-layout">
        <aside className="file-panel">
          <div className="panel-heading"><span>Workspace</span><small>{files.length} files</small></div>
          <div className="import-form">
            <label htmlFor="repo">Public GitHub repository</label>
            <div><input id="repo" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repository" /><button onClick={() => void importRepository()} disabled={busy} aria-label="Import repository"><ArrowLeft className="import-arrow" size={16} /></button></div>
            <label htmlFor="repo-ref">Git ref <span>optional</span></label>
            <input id="repo-ref" className="ref-input" value={repoRef} onChange={(event) => setRepoRef(event.target.value)} placeholder="branch, tag, or commit" />
            <button className="archive-button" onClick={() => archiveInput.current?.click()}><Upload size={14} /> Import zip archive</button>
            <input ref={archiveInput} type="file" accept=".zip,application/zip" hidden onChange={(event) => void importArchive(event)} />
          </div>
          <nav className="file-list" aria-label="Workspace files">
            {files.map((path) => (
              <button key={path} className={path === selectedPath ? "active" : ""} onClick={() => void selectFile(path)}>
                {fileIcon(path)}<span>{path}</span>{proposal?.path === path && <i />}
              </button>
            ))}
          </nav>
          <div className="storage-note"><span>OPFS</span><p>Files persist in browser-managed storage. Export anything you cannot afford to lose.</p></div>
        </aside>

        <section className="editor-panel" aria-label="File editor">
          <div className="editor-tabs">
            <span className="active">{selectedPath || "No file"}{editor !== savedEditor && <i />}</span>
            <button disabled={!selectedPath || editor === savedEditor} onClick={() => void saveEditor()}><Save size={14} /> Save</button>
          </div>
          <textarea
            className="code-editor"
            aria-label="Code editor"
            spellCheck={false}
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
          <div className="editor-status"><span>UTF-8</span><span>Spaces: 2</span><span>{editor.split("\n").length} lines</span></div>
        </section>

        <aside className="agent-panel">
          <div className="agent-heading"><div><Bot size={18} /><span>Agent</span></div><small>BYOK · local tools</small></div>
          <div className="agent-scroll">
            <div className="agent-intro"><Sparkles size={18} /><p>{answer}</p></div>

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
              <button className="demo-button" onClick={() => void runDemo()} disabled={busy}><Play size={14} /> Local demo</button>
              <button className="run-button" onClick={() => void runAgent()} disabled={busy || !task.trim()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Run with Claude
              </button>
            </div>
          </div>
        </aside>
      </div>

      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>
  );
}
