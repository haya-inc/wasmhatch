import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { HatchlingSwarm, type ChatItem, type HatchlingState, type RunConfig } from "../lib/agent-session";
import { MAX_HATCHLINGS, MAIN_THREAD_ID, SCHEDULE_LIMITS } from "../lib/agent-threads";
import { detectBuiltinAiToolLoopSupport } from "../lib/builtin-ai-loop";
import type { HtmlArtifact } from "../lib/artifact";
import { type PermissionDecision, type WritePermissionRequest } from "../lib/chat-permissions";
import { type WritePolicy } from "../lib/chat-tools";
import { GoogleOAuthSession, type GoogleOAuthStatus } from "../lib/google-oauth";
import { parseSensitiveScopesFlag, resolveGoogleScopes } from "../lib/google-scopes";
import { parseMarkdown, type MarkdownInline } from "../lib/markdown";
import { createZipArchive } from "../lib/archive";
import { loadChatSettings, saveChatSettings } from "../lib/chat-settings";
import { CLOUD_PROVIDERS, getCloudProvider, type ChatProviderId } from "../lib/chat-providers";
import { FIRST_RUN_CSV_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "../lib/first-run-csv-sample";
import { isProtectedAgentPath } from "../lib/secrets";
import { PROMPT_API_LANGUAGES } from "../lib/builtin-ai-language";
import { activeLocale, localePreference, setLocalePreference } from "../lib/i18n";
import { AUTO_LOCALE, UI_LOCALES } from "../lib/locales";
import type { OfficeCharacter } from "../lib/pixel-office";
import { type TicketStatus } from "../lib/tickets";
import {
  formatBytes,
  inspectBrowserStorage,
  requestPersistentStorage,
  seedSampleFiles,
  type BrowserStorageStatus
} from "../lib/workspace";
import { ArtifactPanel } from "./ArtifactPanel";
import { HatchlingOffice } from "./HatchlingOffice";

interface PendingPermission {
  request: WritePermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

const GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
// Sensitive Google scopes (opening Sheets/Docs/Slides by URL or ID, and Calendar)
// unlock only when a deployment opts in AFTER Google's Sensitive-scope verification
// clears. Leave VITE_GOOGLE_SENSITIVE_SCOPES unset in production; the default keeps
// the app on the non-sensitive drive.file scope with no unverified-app warning.
const GOOGLE_SENSITIVE_ENABLED = parseSensitiveScopesFlag(import.meta.env.VITE_GOOGLE_SENSITIVE_SCOPES);

// UI-only sentinel: "Custom" reveals a free-text model ID field.
const CUSTOM_MODEL = "__custom__";

const AUTO_WORK_INTERVALS = [1, 5, 10, 30, 60] as const;

/** Which sidebars are open; the choice sticks per device. */
interface ColumnLayout {
  left: boolean;
  right: boolean;
}

const LAYOUT_KEY = "wasmhatch-chat-layout-v1";

function loadColumnLayout(): ColumnLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ColumnLayout>;
      return { left: parsed.left !== false, right: parsed.right !== false };
    }
  } catch {
    /* layout preference is cosmetic; a blocked store falls back to defaults */
  }
  return { left: true, right: true };
}

function saveColumnLayout(layout: ColumnLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* the preference simply won't survive a reload */
  }
}

/**
 * Deep-link routing per hatchling: ?view=chat&hatch=<thread id>. The id is
 * device-local (the registry lives in this browser), so this is navigation —
 * reload, bookmarks, back/forward — not a sharing feature. The main
 * hatchling keeps the clean parameter-free URL as its canonical form.
 */
const HATCH_PARAM = "hatch";

function hatchIdFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get(HATCH_PARAM);
  return value && /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : null;
}

function locationWithHatch(threadId: string): string {
  const url = new URL(window.location.href);
  if (threadId === MAIN_THREAD_ID) url.searchParams.delete(HATCH_PARAM);
  else url.searchParams.set(HATCH_PARAM, threadId);
  return url.pathname + url.search + url.hash;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === "left" ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
    </svg>
  );
}

interface ChromeLanguageModelApi {
  create(options: {
    signal?: AbortSignal;
    initialPrompts: readonly { role: "system"; content: string }[];
    expectedInputs?: unknown;
    expectedOutputs?: unknown;
  }): Promise<{
    prompt(input: string, options: {
      signal?: AbortSignal;
      responseConstraint?: unknown;
      omitResponseConstraintInput?: boolean;
    }): Promise<string>;
    destroy(): void;
  }>;
}

function InlineNodes({ nodes }: { nodes: MarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") return <code key={index}>{node.text}</code>;
        if (node.kind === "strong") return <strong key={index}><InlineNodes nodes={node.inline} /></strong>;
        if (node.kind === "em") return <em key={index}><InlineNodes nodes={node.inline} /></em>;
        if (node.kind === "link") {
          return <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">{node.text}</a>;
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((block, index) => {
        if (block.kind === "code") {
          return <pre key={index} className="chat-md-code"><code>{block.text}</code></pre>;
        }
        if (block.kind === "heading") {
          // Demoted inside a bubble: the page owns h1/h2, a message never does.
          const Tag = (["h3", "h4", "h5"] as const)[block.level - 1];
          return <Tag key={index}><InlineNodes nodes={block.inline} /></Tag>;
        }
        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}><InlineNodes nodes={item} /></li>
          ));
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return <p key={index}><InlineNodes nodes={block.inline} /></p>;
      })}
    </>
  );
}

function storageSummary(status: BrowserStorageStatus): string {
  const state = status.persistence === "persistent"
    ? t`Your data is pinned — this browser won't clear it on its own.`
    : status.persistence === "best-effort"
      ? t`Not pinned yet — the browser could clear saved work if this device runs low on space.`
      : t`This browser can't promise to keep data around, so a backup is the safest bet.`;
  if (status.originUsageBytes === null) return state;
  const used = formatBytes(status.originUsageBytes);
  return `${state} ${t`${used} used.`}`;
}

function hatchlingStatusLine(state: HatchlingState, now: number): string {
  if (state.running) return state.runKind === "auto" ? t`Auto work in progress…` : t`Working…`;
  if (state.mood === "error") return t`Needs attention`;
  if (state.thread.schedule.enabled) {
    if (state.autoBlocker === "exhausted") return t`Auto budget used up`;
    if (state.autoSkipNote) return t`Auto work waiting`;
    if (state.nextAutoRunAt !== null) {
      const minutes = Math.max(0, Math.round((state.nextAutoRunAt - now) / 60_000));
      return minutes <= 0 ? t`Next auto run any moment` : t`Next auto run in ~${minutes} min`;
    }
    return t`Auto work on`;
  }
  return state.mood === "done" && state.lastActivity ? state.lastActivity : t`Resting`;
}

function ticketStatusLabel(status: TicketStatus): string {
  switch (status) {
    case "todo": return t`To do`;
    case "doing": return t`Doing`;
    case "blocked": return t`Blocked`;
    case "done": return t`Done`;
  }
}

export function ChatPage() {
  const [initialSettings] = useState(() => loadChatSettings());
  const restoredCloud = initialSettings.provider === "builtin" ? null : initialSettings.provider;
  const [provider, setProvider] = useState<ChatProviderId>(initialSettings.provider);
  const [apiKey, setApiKey] = useState(restoredCloud ? initialSettings.keys[restoredCloud] ?? "" : "");
  const [model, setModel] = useState(restoredCloud ? initialSettings.models[restoredCloud] ?? getCloudProvider(restoredCloud).defaultModel : "");
  const [rememberKey, setRememberKey] = useState(initialSettings.rememberKey);
  const [webSearch, setWebSearch] = useState(initialSettings.webSearch);
  const [writeMode, setWriteMode] = useState<WritePolicy>("autonomous");
  const [builtinAvailability, setBuiltinAvailability] = useState<string>("checking");
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const [artifact, setArtifact] = useState<HtmlArtifact | null>(null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [viewer, setViewer] = useState<{ path: string; content: string } | null>(null);
  const [storageStatus, setStorageStatus] = useState<BrowserStorageStatus | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinNote, setPinNote] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [ticketDraft, setTicketDraft] = useState("");
  const [columns, setColumns] = useState<ColumnLayout>(loadColumnLayout);
  const [mcpUrls, setMcpUrls] = useState<Record<string, string>>({});
  const [mcpTokens, setMcpTokens] = useState<Record<string, string>>({});
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  // UI language. Changing it activates the catalog in place (no reload), and
  // this state update is what re-renders the page in the new language.
  const [langPref, setLangPref] = useState<string>(localePreference);

  const keysRef = useRef(initialSettings.keys);
  const modelsRef = useRef(initialSettings.models);
  const configRef = useRef<RunConfig>({
    provider: initialSettings.provider,
    apiKey: restoredCloud ? initialSettings.keys[restoredCloud] ?? "" : "",
    model: "",
    webSearch: initialSettings.webSearch,
    writeMode: "autonomous",
    builtinAvailability: "checking"
  });
  configRef.current = { provider, apiKey, model, webSearch, writeMode, builtinAvailability };

  const googleSession = useRef(new GoogleOAuthSession());
  const [googleStatus, setGoogleStatus] = useState<GoogleOAuthStatus>(() => googleSession.current.status());
  const googleStatusRef = useRef(googleStatus);
  googleStatusRef.current = googleStatus;

  const listRef = useRef<HTMLDivElement | null>(null);

  const gate = useCallback((request: WritePermissionRequest) => {
    return new Promise<PermissionDecision>((resolve) => {
      setPermissionQueue((queue) => [...queue, { request, resolve }]);
    });
  }, []);

  const [swarm] = useState(() => new HatchlingSwarm({
    getConfig: () => configRef.current,
    gate,
    onArtifact: setArtifact,
    google: {
      isConnected: () => googleStatusRef.current.connected,
      sensitiveEnabled: GOOGLE_SENSITIVE_ENABLED,
      getToken: (signal) => googleSession.current.credentialProvider().getToken(signal)
    },
    getBuiltinApi: () => (globalThis as typeof globalThis & { LanguageModel?: ChromeLanguageModelApi }).LanguageModel
  }));
  useEffect(() => () => swarm.dispose(), [swarm]);

  useSyncExternalStore(swarm.subscribe, swarm.getVersion, swarm.getVersion);
  const threads = swarm.listThreads();
  const selectedId = swarm.selectedThreadId;
  const selected = swarm.getState(selectedId);
  const items = selected?.items ?? [];
  const running = selected?.running ?? false;
  const now = Date.now();

  const notice = useCallback((text: string, tone: "info" | "error" = "info") => {
    swarm.notice(swarm.selectedThreadId, text, tone);
  }, [swarm]);

  const refreshFiles = useCallback(async () => {
    try {
      const paths = await swarm.workspaceFor(swarm.selectedThreadId).listFiles();
      setFiles(paths.filter((path) => !isProtectedAgentPath(path)));
    } catch {
      setFiles([]);
    }
  }, [swarm]);

  useEffect(() => {
    void detectBuiltinAiToolLoopSupport().then(setBuiltinAvailability);
  }, []);

  useEffect(() => {
    saveColumnLayout(columns);
  }, [columns]);

  // Deep link in, back/forward across hatchlings.
  const [urlRoutingReady, setUrlRoutingReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void swarm.ready.then(() => {
      if (cancelled) return;
      const fromUrl = hatchIdFromLocation();
      if (fromUrl && swarm.getState(fromUrl)) swarm.select(fromUrl);
      setUrlRoutingReady(true);
    });
    const onPopState = () => {
      const fromUrl = hatchIdFromLocation();
      swarm.select(fromUrl && swarm.getState(fromUrl) ? fromUrl : MAIN_THREAD_ID);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
  }, [swarm]);

  // Keep the URL in step with the selection. The first sync after boot
  // replaces (normalizing a stale or invalid deep link without polluting
  // history); every later change pushes so Back walks the selection.
  const firstUrlSync = useRef(true);
  useEffect(() => {
    if (!urlRoutingReady) return;
    const current = hatchIdFromLocation() ?? MAIN_THREAD_ID;
    if (current === selectedId) {
      firstUrlSync.current = false;
      return;
    }
    if (firstUrlSync.current) {
      history.replaceState(null, "", locationWithHatch(selectedId));
      firstUrlSync.current = false;
    } else {
      history.pushState(null, "", locationWithHatch(selectedId));
    }
  }, [urlRoutingReady, selectedId]);

  const selectedWriteCount = selected?.writeCount ?? 0;
  useEffect(() => {
    void swarm.ready.then(() => refreshFiles());
  }, [refreshFiles, selectedId, selectedWriteCount, swarm]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items.length, permissionQueue]);

  useEffect(() => {
    let cancelled = false;
    void inspectBrowserStorage().then((status) => {
      if (!cancelled) setStorageStatus(status);
    });
    return () => { cancelled = true; };
  }, [files]);

  useEffect(() => {
    if (provider !== "builtin") {
      const key = apiKey.trim();
      if (key) keysRef.current[provider] = key;
      else delete keysRef.current[provider];
      const chosenModel = model.trim();
      if (chosenModel) modelsRef.current[provider] = chosenModel;
      else delete modelsRef.current[provider];
    }
    saveChatSettings({ provider, models: modelsRef.current, keys: keysRef.current, rememberKey, webSearch });
  }, [provider, apiKey, model, rememberKey, webSearch]);

  const decidePermission = useCallback((decision: PermissionDecision) => {
    setPermissionQueue((queue) => {
      const [first, ...rest] = queue;
      first?.resolve(decision);
      return rest;
    });
  }, []);

  const send = useCallback(async () => {
    const task = input.trim();
    if (!task || swarm.isRunning(swarm.selectedThreadId)) return;
    setInput("");
    await swarm.send(swarm.selectedThreadId, task);
  }, [input, swarm]);

  const stop = useCallback(() => {
    swarm.stop(swarm.selectedThreadId);
  }, [swarm]);

  const startNewChat = useCallback(() => {
    void swarm.newChat(swarm.selectedThreadId);
    setArtifact(null);
    setViewer(null);
  }, [swarm]);

  const switchProvider = useCallback((next: ChatProviderId) => {
    setProvider(next);
    if (next === "builtin") {
      setApiKey("");
      setModel("");
    } else {
      setApiKey(keysRef.current[next] ?? "");
      setModel(modelsRef.current[next] ?? getCloudProvider(next).defaultModel);
    }
    // A different provider means a different model and wire format: wire history resets.
    swarm.handleProviderSwitch();
  }, [swarm]);

  const connectGoogle = useCallback(async () => {
    if (!GOOGLE_CLIENT_ID || googleBusy) return;
    setGoogleBusy(true);
    try {
      setGoogleStatus(await googleSession.current.authorize(GOOGLE_CLIENT_ID, resolveGoogleScopes(GOOGLE_SENSITIVE_ENABLED)));
      notice(GOOGLE_SENSITIVE_ENABLED
        ? t`Google connected. The agent can create Docs, Sheets, and Slides, open ones you share by link, and read or add Calendar events.`
        : t`Google connected. The agent can now create Docs, Sheets, and Slides and edit the ones it creates.`);
    } catch (error) {
      notice(error instanceof Error ? error.message : t`Google authorization failed.`, "error");
    } finally {
      setGoogleBusy(false);
    }
  }, [googleBusy, notice]);

  const disconnectGoogle = useCallback(async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    try {
      setGoogleStatus(await googleSession.current.revoke());
      notice(t`Google access revoked for this tab.`);
    } catch (error) {
      setGoogleStatus(googleSession.current.status());
      notice(error instanceof Error ? error.message : t`Google revocation failed.`, "error");
    } finally {
      setGoogleBusy(false);
    }
  }, [googleBusy, notice]);

  const revertWrite = useCallback((item: ChatItem) => {
    void swarm.revertWrite(swarm.selectedThreadId, item.id);
  }, [swarm]);

  const loadSamples = useCallback(async () => {
    await swarm.ready;
    const outcome = await seedSampleFiles(swarm.workspaceFor(swarm.selectedThreadId), FIRST_RUN_SAMPLE_FILES);
    await refreshFiles();
    if (outcome.mode === "fresh") {
      notice(t`A messy sample spreadsheet is ready — ask for a cleanup and watch every change land.`);
    } else if (outcome.written.length) {
      notice(t`Sample spreadsheet added next to your files — nothing of yours was touched.`);
    } else {
      notice(t`The sample spreadsheet is already in your files.`);
    }
    setInput((current) => (current.trim() ? current : FIRST_RUN_CSV_SAMPLE.task));
  }, [notice, refreshFiles, swarm]);

  const openFile = useCallback(async (path: string) => {
    const content = await swarm.workspaceFor(swarm.selectedThreadId).readFile(path);
    setViewer({ path, content });
  }, [swarm]);

  const pinStorage = useCallback(async () => {
    if (pinBusy) return;
    setPinBusy(true);
    try {
      const granted = await requestPersistentStorage();
      setStorageStatus(await inspectBrowserStorage());
      setPinNote(granted
        ? t`Done — this browser will keep your data safe.`
        : t`The browser said not yet. It usually agrees once you've used the app a little more — until then, a backup is the surest safety.`);
    } finally {
      setPinBusy(false);
    }
  }, [pinBusy]);

  const backupWorkspace = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const workspace = swarm.workspaceFor(swarm.selectedThreadId);
      const paths = (await workspace.listFiles()).filter((path) => !isProtectedAgentPath(path));
      const entries = await Promise.all(paths.map(async (path) => ({
        path,
        content: await workspace.readFile(path)
      })));
      const bytes = createZipArchive(entries);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      const stampDate = new Date();
      const stamp = [
        stampDate.getFullYear(),
        String(stampDate.getMonth() + 1).padStart(2, "0"),
        String(stampDate.getDate()).padStart(2, "0")
      ].join("-");
      link.download = `wasmhatch-backup-${stamp}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      notice(error instanceof Error ? error.message : t`The backup could not be created.`, "error");
    } finally {
      setBackupBusy(false);
    }
  }, [backupBusy, notice, swarm]);

  const downloadFile = useCallback(async (path: string, content: string) => {
    const ext = path.split(".").pop() ?? "";
    const mimeMap: Record<string, string> = {
      md: "text/markdown",
      csv: "text/csv",
      json: "application/json",
      txt: "text/plain",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      ts: "text/typescript",
      tsx: "text/typescript",
      py: "text/x-python",
      sh: "text/x-shellscript",
      yaml: "text/yaml",
      yml: "text/yaml",
    };
    const mimeType = mimeMap[ext] ?? "text/plain";
    const bytes = new TextEncoder().encode(content);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").pop() ?? path;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const addTicket = useCallback(async () => {
    const title = ticketDraft.trim();
    if (!title) return;
    setTicketDraft("");
    try {
      await swarm.tickets.create({ title, createdBy: "user" });
    } catch (error) {
      notice(error instanceof Error ? error.message : t`The ticket could not be created.`, "error");
    }
  }, [notice, swarm, ticketDraft]);

  const connectMcp = useCallback(async (serverId: string) => {
    if (mcpBusy) return;
    setMcpBusy(serverId);
    try {
      const url = mcpUrls[serverId];
      const token = mcpTokens[serverId]?.trim();
      const toolCount = await swarm.connectMcp(serverId, { url, bearerToken: token || undefined });
      notice(plural(toolCount, {
        one: "MCP server connected — # tool available to every hatchling.",
        other: "MCP server connected — # tools available to every hatchling."
      }));
    } catch (error) {
      notice(error instanceof Error ? error.message : t`MCP connection failed.`, "error");
    } finally {
      setMcpBusy(null);
    }
  }, [mcpBusy, mcpTokens, mcpUrls, notice, swarm]);

  const activePermission = permissionQueue[0];
  const providerDef = provider === "builtin" ? null : getCloudProvider(provider);
  const modelChoices = providerDef?.models ?? [];
  const curatedModel = modelChoices.some((choice) => choice.value === model);
  const tickets = swarm.tickets.list();
  const mcpStatuses = swarm.mcpStatus();
  const threadNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const state of threads) names.set(state.thread.id, state.thread.name);
    return names;
  }, [threads]);

  const officeCharacters: OfficeCharacter[] = threads.map((state) => ({
    id: state.thread.id,
    name: state.thread.name,
    species: state.thread.species,
    mood: state.mood,
    running: state.running,
    scheduled: state.thread.schedule.enabled,
    selected: state.thread.id === selectedId
  }));

  const selectedSchedule = selected?.thread.schedule;

  return (
    <div className="fresh chat-shell">
      <header className="chat-header">
        <button
          className="chat-col-toggle"
          type="button"
          aria-expanded={columns.left}
          aria-label={columns.left ? t`Hide the team sidebar` : t`Show the team sidebar`}
          title={columns.left ? t`Hide the team sidebar` : t`Show the team sidebar`}
          onClick={() => setColumns((current) => ({ ...current, left: !current.left }))}
        >
          <Chevron direction={columns.left ? "left" : "right"} />
        </button>
        <a className="chat-brand" href="./">WasmHatch</a>
        <span className="chat-tagline"><Trans>Your AI assistant, right in this tab — fast, visible, and undoable.</Trans></span>
        <div className="chat-header-right">
          {items.length > 0 && (
            <button className="button button-quiet chat-new" type="button" onClick={startNewChat} disabled={running}>
              <Trans>New chat</Trans>
            </button>
          )}
          <button
            className="chat-col-toggle"
            type="button"
            aria-expanded={columns.right}
            aria-label={columns.right ? t`Hide the tools sidebar` : t`Show the tools sidebar`}
            title={columns.right ? t`Hide the tools sidebar` : t`Show the tools sidebar`}
            onClick={() => setColumns((current) => ({ ...current, right: !current.right }))}
          >
            <Chevron direction={columns.right ? "right" : "left"} />
          </button>
        </div>
      </header>

      <div className={`chat-columns${columns.left ? " has-left" : ""}${columns.right ? " has-right" : ""}`}>
        <main className="chat-main">
          <div className="chat-transcript" ref={listRef}>
            {items.length === 0 && (
              <div className="chat-empty">
                <h1><Trans>What do you want to get done?</Trans></h1>
                <p>
                  <Trans>
                    Ask in your own words — it fixes spreadsheets, writes documents, and builds
                    reports right here. Every change is shown as it happens, and undo is one click.
                    Prefer to approve things first? Switch to Careful in the sidebar.
                  </Trans>
                </p>
                <button className="button" type="button" onClick={() => { void loadSamples(); }}>
                  <Trans>Add a sample spreadsheet</Trans>
                </button>
              </div>
            )}
            {items.map((item) => {
              if (item.kind === "user") return <div key={item.id} className="chat-bubble chat-user">{item.text}</div>;
              if (item.kind === "assistant") {
                return (
                  <div key={item.id} className={item.streaming ? "chat-bubble chat-assistant chat-streaming" : "chat-bubble chat-assistant"}>
                    <AssistantMarkdown text={item.text} />
                  </div>
                );
              }
              if (item.kind === "write" && item.write) {
                return (
                  <div key={item.id} className={item.write.reverted ? "chat-write chat-write-reverted" : "chat-write"}>
                    <details>
                      <summary>
                        {item.text}
                        {item.write.reverted ? ` — ${t`reverted`}` : ""}
                        <span className="chat-write-hint"> · <Trans>view diff</Trans></span>
                      </summary>
                      <pre className="chat-diff">
                        {item.write.diff.split("\n").map((line, index) => (
                          <span
                            key={index}
                            className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : undefined}
                          >
                            {line}
                            {"\n"}
                          </span>
                        ))}
                      </pre>
                    </details>
                    {!item.write.creates && !item.write.reverted && (
                      <button className="button button-quiet" type="button" onClick={() => { revertWrite(item); }}>
                        <Trans>Revert</Trans>
                      </button>
                    )}
                  </div>
                );
              }
              if (item.kind === "tool") {
                return (
                  <div key={item.id} className={`chat-tool chat-tool-${item.toolState ?? "running"}`}>
                    <span className="chat-tool-name">{item.toolName}</span>
                    <span>{item.text}</span>
                    <span className="chat-tool-state">
                      {item.toolState === "running" ? t`running` : item.toolState === "error" ? t`failed` : t`done`}
                    </span>
                  </div>
                );
              }
              if (item.kind === "sources" && item.sources?.length) {
                return (
                  <div key={item.id} className="chat-sources">
                    <span><Trans>Sources:</Trans></span>
                    {item.sources.map((source, index) => (
                      <a key={index} href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
                    ))}
                  </div>
                );
              }
              return (
                <div key={item.id} className={item.tone === "error" ? "chat-notice chat-notice-error" : "chat-notice"}>
                  {item.text}
                </div>
              );
            })}

            {activePermission && (
              <section className="chat-permission" aria-label={t`Write approval required`}>
                <h2>
                  {activePermission.request.creates
                    ? t`Create ${activePermission.request.path}`
                    : t`Update ${activePermission.request.path}`}
                </h2>
                <p className="chat-permission-meta">
                  {activePermission.request.beforeBytes.toLocaleString()} → {activePermission.request.afterBytes.toLocaleString()}{" "}
                  <Trans>bytes. Nothing is written until you decide.</Trans>
                </p>
                <pre className="chat-diff">
                  {activePermission.request.diff.split("\n").map((line, index) => (
                    <span
                      key={index}
                      className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : undefined}
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
                <div className="chat-permission-actions">
                  <button className="button button-primary" type="button" onClick={() => decidePermission("allow-once")}>
                    <Trans>Allow once</Trans>
                  </button>
                  <button className="button" type="button" onClick={() => decidePermission("always-allow")}>
                    <Trans>Always allow this file</Trans>
                  </button>
                  <button className="button button-quiet" type="button" onClick={() => decidePermission("reject")}>
                    <Trans>Reject</Trans>
                  </button>
                </div>
              </section>
            )}
          </div>

          <div className="chat-composer">
            <textarea
              aria-label={t`Message the agent`}
              placeholder={selected ? t`Ask ${selected.thread.name} for the outcome you need…` : t`Describe the outcome you need…`}
              value={input}
              rows={3}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {running
              ? <button className="button" type="button" onClick={stop}><Trans>Stop</Trans></button>
              : <button className="button button-primary" type="button" disabled={!input.trim()} onClick={() => { void send(); }}><Trans>Send</Trans></button>}
          </div>
        </main>

        {columns.left && (
        <aside className="chat-side chat-side-left">
          <section className="chat-panel">
            <h2><Trans>Hatchlings</Trans></h2>
            <HatchlingOffice characters={officeCharacters} onSelect={(id) => swarm.select(id)} />
            <ul className="hatchling-list">
              {threads.map((state) => (
                <li key={state.thread.id}>
                  <button
                    type="button"
                    className={state.thread.id === selectedId ? "hatchling-row hatchling-row-selected" : "hatchling-row"}
                    onClick={() => swarm.select(state.thread.id)}
                  >
                    <span className={`hatchling-dot hatchling-dot-${state.running ? "running" : state.mood}`} aria-hidden="true" />
                    <span className="hatchling-name">{state.thread.name}</span>
                    <span className="hatchling-status">{hatchlingStatusLine(state, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="hatchling-actions">
              {threads.length < MAX_HATCHLINGS && (
                <button
                  className="button"
                  type="button"
                  onClick={() => { void swarm.hatch().then((id) => swarm.select(id)); }}
                >
                  <Trans>Hatch a new one</Trans>
                </button>
              )}
              <label className="chat-remember">
                <input
                  type="checkbox"
                  checked={swarm.isGloballyPaused()}
                  onChange={(event) => swarm.setGlobalPause(event.target.checked)}
                />
                <span><Trans>Pause all auto work</Trans></span>
              </label>
            </div>
            {selected && selectedSchedule && (
              <div className="hatchling-config">
                <label className="chat-field">
                  <span><Trans>Name</Trans></span>
                  <input
                    type="text"
                    value={selected.thread.name}
                    maxLength={24}
                    onChange={(event) => { void swarm.rename(selectedId, event.target.value); }}
                  />
                </label>
                <label className="chat-remember">
                  <input
                    type="checkbox"
                    checked={selectedSchedule.enabled}
                    onChange={(event) => { void swarm.setSchedule(selectedId, { enabled: event.target.checked }); }}
                  />
                  <span><Trans>Auto work while this tab is open</Trans></span>
                </label>
                {selectedSchedule.enabled && (
                  <>
                    <label className="chat-field">
                      <span><Trans>Every</Trans></span>
                      <select
                        value={selectedSchedule.intervalMinutes}
                        onChange={(event) => { void swarm.setSchedule(selectedId, { intervalMinutes: Number(event.target.value) }); }}
                      >
                        {AUTO_WORK_INTERVALS.map((minutes) => (
                          <option key={minutes} value={minutes}>{t`${minutes} min`}</option>
                        ))}
                        {!AUTO_WORK_INTERVALS.includes(selectedSchedule.intervalMinutes as typeof AUTO_WORK_INTERVALS[number]) && (
                          <option value={selectedSchedule.intervalMinutes}>{t`${selectedSchedule.intervalMinutes} min`}</option>
                        )}
                      </select>
                    </label>
                    <label className="chat-field">
                      <span><Trans>Each run</Trans></span>
                      <textarea
                        rows={3}
                        value={selectedSchedule.prompt}
                        maxLength={SCHEDULE_LIMITS.maxPromptChars}
                        onChange={(event) => { void swarm.setSchedule(selectedId, { prompt: event.target.value }); }}
                      />
                    </label>
                    <p className="chat-hint">
                      <Trans>{selected.runsLeft} of {selectedSchedule.maxAutoRuns} auto runs left.</Trans>{" "}
                      <button
                        className="chat-linklike"
                        type="button"
                        onClick={() => { void swarm.resetScheduleBudget(selectedId); }}
                      >
                        <Trans>Reset budget</Trans>
                      </button>
                    </p>
                    {selected.autoSkipNote && <p className="chat-hint">{selected.autoSkipNote}</p>}
                    <p className="chat-hint">
                      <Trans>
                        Runs only while this tab is open, in Fast mode, with its own token budget — it stops
                        itself after repeated failures.
                      </Trans>
                    </p>
                  </>
                )}
                {selectedId !== MAIN_THREAD_ID && (
                  <button
                    className="button button-quiet"
                    type="button"
                    disabled={running}
                    onClick={() => {
                      if (window.confirm(t`Remove ${selected.thread.name}? Its files and conversation are deleted (the shared ticket board stays).`)) {
                        void swarm.removeHatchling(selectedId);
                      }
                    }}
                  >
                    <Trans>Remove this hatchling</Trans>
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="chat-panel">
            <h2><Trans>Tickets</Trans></h2>
            <div className="ticket-add">
              <input
                type="text"
                aria-label={t`New ticket title`}
                placeholder={t`Queue a piece of work…`}
                value={ticketDraft}
                onChange={(event) => setTicketDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addTicket();
                  }
                }}
              />
              <button className="button" type="button" disabled={!ticketDraft.trim()} onClick={() => { void addTicket(); }}>
                <Trans>Add</Trans>
              </button>
            </div>
            {tickets.length === 0
              ? <p className="chat-hint"><Trans>The shared work queue is empty. Add tickets here or let hatchlings queue their own follow-ups.</Trans></p>
              : (
                <ul className="ticket-list">
                  {tickets.map((ticket) => (
                    <li key={ticket.id} className={`ticket ticket-${ticket.status}`}>
                      <span className={`ticket-chip ticket-chip-${ticket.status}`}>{ticketStatusLabel(ticket.status)}</span>
                      <span className="ticket-title">{ticket.title}</span>
                      {ticket.assignee && (
                        <span className="ticket-assignee">{threadNames.get(ticket.assignee) ?? ticket.assignee}</span>
                      )}
                      {ticket.note && <span className="ticket-note">{ticket.note}</span>}
                      <span className="ticket-actions">
                        {ticket.status !== "done" && (
                          <button
                            className="chat-linklike"
                            type="button"
                            onClick={() => { void swarm.tickets.update(ticket.id, { status: "done" }); }}
                          >
                            <Trans>Done</Trans>
                          </button>
                        )}
                        {ticket.status === "done" && (
                          <button
                            className="chat-linklike"
                            type="button"
                            onClick={() => { void swarm.tickets.update(ticket.id, { status: "todo", assignee: null }); }}
                          >
                            <Trans>Reopen</Trans>
                          </button>
                        )}
                        <button
                          className="chat-linklike"
                          type="button"
                          onClick={() => { void swarm.tickets.remove(ticket.id); }}
                        >
                          <Trans>Delete</Trans>
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </aside>
        )}

        {columns.right && (
        <aside className="chat-side chat-side-right">
          <section className="chat-panel">
            <h2><Trans>Assistant</Trans></h2>
            <label className="chat-field">
              <span><Trans>Language</Trans></span>
              <select
                value={langPref}
                onChange={(event) => {
                  const next = event.target.value;
                  setLangPref(next);
                  void setLocalePreference(next);
                }}
              >
                <option value={AUTO_LOCALE}>{t`Auto — match this browser`}</option>
                {UI_LOCALES.map((locale) => (
                  // Endonyms on purpose: every reader can find their own language.
                  <option key={locale.code} value={locale.code}>{locale.label}</option>
                ))}
              </select>
            </label>
            <label className="chat-field">
              <span><Trans>Autonomy</Trans></span>
              <select
                value={writeMode}
                onChange={(event) => setWriteMode(event.target.value as WritePolicy)}
              >
                <option value="autonomous">{t`Fast — just does it (undo anytime)`}</option>
                <option value="careful">{t`Careful — asks before saving`}</option>
              </select>
            </label>
            <label className="chat-field">
              <span><Trans>Provider</Trans></span>
              <select
                value={provider}
                onChange={(event) => switchProvider(event.target.value as ChatProviderId)}
              >
                <option value="builtin">
                  {t`Built into Chrome — free, no key`}{builtinAvailability === "available" ? "" : ` (${builtinAvailability})`}
                </option>
                {CLOUD_PROVIDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </label>
            {providerDef && (
              <>
                {!providerDef.keyless && (
                  <>
                    <label className="chat-field">
                      <span><Trans>API key</Trans></span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={apiKey}
                        placeholder={providerDef.keyPlaceholder}
                        onChange={(event) => setApiKey(event.target.value)}
                        aria-describedby="key-storage-hint"
                      />
                    </label>
                    <label className="chat-remember">
                      <input
                        type="checkbox"
                        checked={rememberKey}
                        onChange={(event) => setRememberKey(event.target.checked)}
                        aria-describedby="key-storage-hint"
                      />
                      <span><Trans>Remember on this device</Trans></span>
                    </label>
                  </>
                )}
                <label className="chat-field">
                  <span><Trans>Model</Trans></span>
                  <select
                    value={curatedModel ? model : CUSTOM_MODEL}
                    onChange={(event) => {
                      const next = event.target.value;
                      setModel(next === CUSTOM_MODEL ? "" : next);
                    }}
                  >
                    {modelChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                    ))}
                    <option value={CUSTOM_MODEL}>{t`Custom model ID…`}</option>
                  </select>
                </label>
                {!curatedModel && (
                  <label className="chat-field">
                    <span><Trans>Custom model ID</Trans></span>
                    <input
                      type="text"
                      value={model}
                      placeholder={providerDef.defaultModel}
                      onChange={(event) => setModel(event.target.value)}
                    />
                  </label>
                )}
                {providerDef.webSearch && (
                  <label className="chat-remember">
                    <input
                      type="checkbox"
                      checked={webSearch}
                      onChange={(event) => setWebSearch(event.target.checked)}
                    />
                    <span><Trans>Web search</Trans></span>
                  </label>
                )}
                {providerDef.webSearch && webSearch && (
                  <p className="chat-hint">
                    <Trans>
                      The model can search the web through {providerDef.host}. Searches are billed by your
                      provider alongside tokens; untick to turn this off.
                    </Trans>
                  </p>
                )}
                {providerDef.keyless ? (
                  <p className="chat-hint">
                    <Trans>
                      No key needed — this talks to Ollama on your own computer. Start Ollama with this site
                      allowed (set OLLAMA_ORIGINS), then pick the model you've pulled (ollama list).
                    </Trans>
                  </p>
                ) : (
                  <p className="chat-hint" id="key-storage-hint">
                    <Trans>Your key goes only to {providerDef.host} — nowhere else.</Trans>{" "}
                    {rememberKey
                      ? t`It's saved in this browser until you untick the box.`
                      : t`Right now it's kept just for this tab and gone when the tab closes.`}
                  </p>
                )}
              </>
            )}
            {provider === "builtin" && builtinAvailability !== "available" && (
              <p className="chat-hint">
                <Trans>On-device model status: {builtinAvailability}. Chrome 138+ on a supported desktop can run tasks without any key.</Trans>
              </p>
            )}
            {provider === "builtin" && !PROMPT_API_LANGUAGES.includes(activeLocale().split("-")[0]) && (
              <p className="chat-hint">
                <Trans>The on-device model does not speak this language yet and will answer in English; cloud providers reply in your language.</Trans>
              </p>
            )}
          </section>

          <section className="chat-panel">
            <h2><Trans>MCP servers</Trans></h2>
            {mcpStatuses.map((status) => (
              <div key={status.server.id} className="mcp-server">
                <p className="mcp-server-head">
                  <span className="mcp-server-label">{status.server.label}</span>
                  <span className={status.connected ? "mcp-state mcp-state-on" : "mcp-state"}>
                    {status.connected
                      ? plural(status.toolCount, { one: "connected · # tool", other: "connected · # tools" })
                      : t`off`}
                  </span>
                </p>
                {status.server.loopback && (
                  <label className="chat-field">
                    <span><Trans>URL (this machine only)</Trans></span>
                    <input
                      type="text"
                      value={mcpUrls[status.server.id] ?? status.url}
                      placeholder="http://localhost:3001/mcp"
                      onChange={(event) => setMcpUrls((current) => ({ ...current, [status.server.id]: event.target.value }))}
                    />
                  </label>
                )}
                <label className="chat-field">
                  <span><Trans>Access token (optional)</Trans></span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={mcpTokens[status.server.id] ?? ""}
                    onChange={(event) => setMcpTokens((current) => ({ ...current, [status.server.id]: event.target.value }))}
                  />
                </label>
                {status.connected
                  ? (
                    <button className="button button-quiet" type="button" onClick={() => { void swarm.disconnectMcp(status.server.id); }}>
                      <Trans>Disconnect</Trans>
                    </button>
                  )
                  : (
                    <button
                      className="button"
                      type="button"
                      disabled={mcpBusy === status.server.id}
                      onClick={() => { void connectMcp(status.server.id); }}
                    >
                      {mcpBusy === status.server.id ? t`Connecting…` : t`Connect`}
                    </button>
                  )}
              </div>
            ))}
            <p className="chat-hint">
              <Trans>
                Connects every hatchling to tools from an MCP server on your machine (Streamable HTTP), e.g.
                a stdio server behind a local proxy. Tokens stay in this tab's memory. Remote servers require
                a deployment-time allowlist entry — never a runtime exception.
              </Trans>
            </p>
          </section>

          <section className="chat-panel">
            <h2>Google</h2>
            {!GOOGLE_CLIENT_ID && (
              <p className="chat-hint">
                <Trans>
                  Not configured for this deployment. Set VITE_GOOGLE_CLIENT_ID to enable Google Docs, Sheets,
                  and Slides tools.
                </Trans>
              </p>
            )}
            {GOOGLE_CLIENT_ID && !googleStatus.connected && (
              <>
                <button className="button" type="button" disabled={googleBusy} onClick={() => { void connectGoogle(); }}>
                  {googleBusy ? t`Connecting…` : t`Connect Google`}
                </button>
                <p className="chat-hint">
                  {GOOGLE_SENSITIVE_ENABLED
                    ? t`The agent can create Docs, Sheets, and Slides, open ones you share by link, and read or add Calendar events. The token stays in this tab; every write is shown before it is applied.`
                    : t`Per-file access only (drive.file): the agent can create Docs, Sheets, and Slides and edit the ones it creates. It cannot browse your existing Drive. The token stays in this tab.`}
                </p>
              </>
            )}
            {GOOGLE_CLIENT_ID && googleStatus.connected && (
              <>
                <p className="chat-hint">
                  {googleStatus.expiresAt
                    ? t`Connected until ${new Date(googleStatus.expiresAt).toLocaleTimeString(activeLocale())}. Docs, Sheets, and Slides tools are active.`
                    : t`Connected for this session. Docs, Sheets, and Slides tools are active.`}
                </p>
                <button className="button button-quiet" type="button" disabled={googleBusy} onClick={() => { void disconnectGoogle(); }}>
                  <Trans>Disconnect Google</Trans>
                </button>
              </>
            )}
          </section>

          <section className="chat-panel">
            <h2><Trans>Your files</Trans></h2>
            <p className="chat-hint">{selected ? t`${selected.thread.name}'s workspace — each hatchling keeps its own files.` : ""}</p>
            {files.length === 0
              ? <p className="chat-hint"><Trans>Nothing here yet. Add the samples or just ask for something — files it creates appear here.</Trans></p>
              : (
                <ul className="chat-files">
                  {files.map((path) => (
                    <li key={path}>
                      <button type="button" onClick={() => { void openFile(path); }}>{path}</button>
                    </li>
                  ))}
                </ul>
              )}
            {swarm.grantedPaths(selectedId).length > 0 && (
              <p className="chat-hint"><Trans>Always-allowed this session: {swarm.grantedPaths(selectedId).join(", ")}</Trans></p>
            )}
          </section>

          <section className="chat-panel">
            <h2><Trans>Storage</Trans></h2>
            {storageStatus && <p className="chat-hint">{storageSummary(storageStatus)}</p>}
            {storageStatus?.persistence === "best-effort" && storageStatus.persistenceRequestAvailable && (
              <button className="button" type="button" disabled={pinBusy} onClick={() => { void pinStorage(); }}>
                {pinBusy ? t`Pinning…` : t`Keep my data safe`}
              </button>
            )}
            {pinNote && <p className="chat-hint">{pinNote}</p>}
            <button
              className="button"
              type="button"
              disabled={backupBusy || files.length === 0}
              onClick={() => { void backupWorkspace(); }}
            >
              {backupBusy ? t`Preparing…` : t`Back up everything`}
            </button>
            <p className="chat-hint">
              {files.length === 0
                ? t`Downloads this hatchling's files as one ZIP you can keep anywhere — add a file first.`
                : t`Downloads this hatchling's files as one ZIP you can keep anywhere.`}
            </p>
          </section>

          {viewer && (
            <section className="chat-panel">
              <h2>{viewer.path}</h2>
              <pre className="chat-viewer">{viewer.content}</pre>
              <button className="button button-quiet" type="button" onClick={() => { void downloadFile(viewer.path, viewer.content); }}><Trans>Download</Trans></button>
              <button className="button button-quiet" type="button" onClick={() => setViewer(null)}><Trans>Close</Trans></button>
            </section>
          )}

          <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
        </aside>
        )}
      </div>
    </div>
  );
}
