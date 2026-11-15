import { useCallback, useEffect, useState } from "react";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HatchlingState, HatchlingSwarm } from "../../lib/agent-session";
import { createZipArchive } from "../../lib/archive";
import type { HtmlArtifact } from "../../lib/artifact";
import { downloadBytes, downloadTextFile } from "../../lib/browser-download";
import { PROMPT_API_LANGUAGES } from "../../lib/builtin-ai-language";
import { CLOUD_PROVIDERS, getCloudProvider, type ChatProviderId } from "../../lib/chat-providers";
import type { WritePolicy } from "../../lib/chat-tools";
import { activeLocale, localePreference, setLocalePreference } from "../../lib/i18n";
import { AUTO_LOCALE, UI_LOCALES } from "../../lib/locales";
import { registryBaseUrl } from "../../lib/portable-hatchling";
import { isProtectedAgentPath } from "../../lib/secrets";
import {
  formatBytes,
  inspectBrowserStorage,
  requestPersistentStorage,
  type BrowserStorageStatus
} from "../../lib/workspace";
import { ArtifactPanel } from "../ArtifactPanel";
import { GOOGLE_CLIENT_ID, GOOGLE_SENSITIVE_ENABLED, type GoogleConnectorController } from "./useGoogleConnector";
import type { PortableAgentFlowController } from "./usePortableAgentFlow";
import type { SessionConnectorsController } from "./useSessionConnectors";

// UI-only sentinel: "Custom" reveals a free-text model ID field.
const CUSTOM_MODEL = "__custom__";

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

export interface ToolsSidebarProps {
  swarm: HatchlingSwarm;
  selectedId: string;
  selected: HatchlingState | null;
  provider: ChatProviderId;
  onSwitchProvider: (next: ChatProviderId) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  rememberKey: boolean;
  onRememberKeyChange: (remember: boolean) => void;
  webSearch: boolean;
  onWebSearchChange: (enabled: boolean) => void;
  writeMode: WritePolicy;
  onWriteModeChange: (mode: WritePolicy) => void;
  builtinAvailability: string;
  google: GoogleConnectorController;
  connectors: SessionConnectorsController;
  portable: PortableAgentFlowController;
  files: readonly string[];
  onOpenFile: (path: string) => Promise<void>;
  viewer: { path: string; content: string } | null;
  onCloseViewer: () => void;
  artifact: HtmlArtifact | null;
  onCloseArtifact: () => void;
  onNotice: (text: string, tone?: "info" | "error") => void;
}

export function ToolsSidebar({
  swarm,
  selectedId,
  selected,
  provider,
  onSwitchProvider,
  apiKey,
  onApiKeyChange,
  model,
  onModelChange,
  rememberKey,
  onRememberKeyChange,
  webSearch,
  onWebSearchChange,
  writeMode,
  onWriteModeChange,
  builtinAvailability,
  google,
  connectors,
  portable,
  files,
  onOpenFile,
  viewer,
  onCloseViewer,
  artifact,
  onCloseArtifact,
  onNotice
}: ToolsSidebarProps) {
  // UI language. Changing it activates the catalog in place (no reload), and
  // this state update re-renders the sidebar in the new language.
  const [langPref, setLangPref] = useState<string>(localePreference);
  const [mcpUrls, setMcpUrls] = useState<Record<string, string>>({});
  const [mcpTokens, setMcpTokens] = useState<Record<string, string>>({});
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<BrowserStorageStatus | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinNote, setPinNote] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const clipboardAvailable = typeof navigator !== "undefined" && !!navigator.clipboard;

  useEffect(() => {
    setCopied(false);
  }, [viewer]);

  useEffect(() => {
    if (!viewer) return;
    const closeViewerOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseViewer();
    };
    window.addEventListener("keydown", closeViewerOnEscape);
    return () => window.removeEventListener("keydown", closeViewerOnEscape);
  }, [onCloseViewer, viewer]);

  useEffect(() => {
    let cancelled = false;
    void inspectBrowserStorage().then((status) => {
      if (!cancelled) setStorageStatus(status);
    });
    return () => { cancelled = true; };
  }, [files]);

  const copyToClipboard = async () => {
    if (!viewer || !clipboardAvailable) return;
    try {
      await navigator.clipboard.writeText(viewer.content);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const connectMcp = useCallback(async (serverId: string) => {
    if (mcpBusy) return;
    setMcpBusy(serverId);
    try {
      const url = mcpUrls[serverId];
      const token = mcpTokens[serverId]?.trim();
      const toolCount = await swarm.connectMcp(serverId, { url, bearerToken: token || undefined });
      onNotice(plural(toolCount, {
        one: "MCP server connected — # tool available to every hatchling.",
        other: "MCP server connected — # tools available to every hatchling."
      }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`MCP connection failed.`, "error");
    } finally {
      setMcpBusy(null);
    }
  }, [mcpBusy, mcpTokens, mcpUrls, onNotice, swarm]);

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
      const stampDate = new Date();
      const stamp = [
        stampDate.getFullYear(),
        String(stampDate.getMonth() + 1).padStart(2, "0"),
        String(stampDate.getDate()).padStart(2, "0")
      ].join("-");
      downloadBytes(bytes, `wasmhatch-backup-${stamp}.zip`, "application/zip");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The backup could not be created.`, "error");
    } finally {
      setBackupBusy(false);
    }
  }, [backupBusy, onNotice, swarm]);

  const exportJournal = () => {
    const result = swarm.exportRunJournal(selectedId);
    if (!result) return;
    downloadTextFile(result.fileName, result.json, "application/json");
    onNotice(t`Run journal exported.`);
  };

  const providerDef = provider === "builtin" ? null : getCloudProvider(provider);
  const modelChoices = providerDef?.models ?? [];
  const curatedModel = modelChoices.some((choice) => choice.value === model);
  const mcpStatuses = swarm.mcpStatus();
  const journal = swarm.runJournal(selectedId);
  const { slackTeam } = connectors;

  return (
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
            onChange={(event) => onWriteModeChange(event.target.value as WritePolicy)}
          >
            <option value="autonomous">{t`Fast — just does it (undo anytime)`}</option>
            <option value="careful">{t`Careful — asks before saving`}</option>
          </select>
        </label>
        <label className="chat-field">
          <span><Trans>Provider</Trans></span>
          <select
            value={provider}
            onChange={(event) => onSwitchProvider(event.target.value as ChatProviderId)}
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
                    onChange={(event) => onApiKeyChange(event.target.value)}
                    aria-describedby="key-storage-hint"
                  />
                </label>
                <label className="chat-remember">
                  <input
                    type="checkbox"
                    checked={rememberKey}
                    onChange={(event) => onRememberKeyChange(event.target.checked)}
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
                  onModelChange(next === CUSTOM_MODEL ? "" : next);
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
                  onChange={(event) => onModelChange(event.target.value)}
                />
              </label>
            )}
            {providerDef.webSearch && (
              <label className="chat-remember">
                <input
                  type="checkbox"
                  checked={webSearch}
                  onChange={(event) => onWebSearchChange(event.target.checked)}
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
        {GOOGLE_CLIENT_ID && !google.googleStatus.connected && (
          <>
            <button className="button" type="button" disabled={google.googleBusy} onClick={() => { void google.connectGoogle(); }}>
              {google.googleBusy ? t`Connecting…` : t`Connect Google`}
            </button>
            <p className="chat-hint">
              {GOOGLE_SENSITIVE_ENABLED
                ? t`The agent can create Docs, Sheets, and Slides, open ones you share by link, and read or add Calendar events. The token stays in this tab; every write is shown before it is applied.`
                : t`Per-file access only (drive.file): the agent can create Docs, Sheets, and Slides and edit the ones it creates. It cannot browse your existing Drive. The token stays in this tab.`}
            </p>
          </>
        )}
        {GOOGLE_CLIENT_ID && google.googleStatus.connected && (
          <>
            <p className="chat-hint">
              {google.googleStatus.expiresAt
                ? t`Connected until ${new Date(google.googleStatus.expiresAt).toLocaleTimeString(activeLocale())}. Docs, Sheets, and Slides tools are active.`
                : t`Connected for this session. Docs, Sheets, and Slides tools are active.`}
            </p>
            <button className="button button-quiet" type="button" disabled={google.googleBusy} onClick={() => { void google.disconnectGoogle(); }}>
              <Trans>Disconnect Google</Trans>
            </button>
          </>
        )}
      </section>

      <section className="chat-panel">
        <h2>Slack</h2>
        {!connectors.slackConnected && (
          <>
            <label className="chat-field">
              <span><Trans>Incoming Webhook URL</Trans></span>
              <input
                type="password"
                autoComplete="off"
                value={connectors.slackDraft}
                placeholder="https://hooks.slack.com/services/…"
                onChange={(event) => connectors.setSlackDraft(event.target.value)}
              />
            </label>
            <button className="button" type="button" onClick={connectors.connectSlack}>
              <Trans>Connect Slack</Trans>
            </button>
            <p className="chat-hint">
              <Trans>
                60-second setup: create an Incoming Webhook in Slack (one channel, one URL) and paste it
                here. The agent gains exactly one ability — posting messages to that channel; it reads
                nothing from Slack. The URL stays in this tab's memory.
              </Trans>
            </p>
          </>
        )}
        {connectors.slackConnected && (
          <>
            <p className="chat-hint">
              <Trans>Connected. Every hatchling can post to the webhook's channel; each post appears in the transcript.</Trans>
            </p>
            <button className="button button-quiet" type="button" onClick={connectors.disconnectSlack}>
              <Trans>Disconnect Slack</Trans>
            </button>
          </>
        )}
        {slackTeam === null && (
          <>
            <label className="chat-field">
              <span><Trans>Bot token (channel tools)</Trans></span>
              <input
                type="password"
                autoComplete="off"
                value={connectors.slackTokenDraft}
                placeholder="xoxb-…"
                onChange={(event) => connectors.setSlackTokenDraft(event.target.value)}
              />
            </label>
            <button className="button" type="button" disabled={connectors.slackTokenBusy || !connectors.slackTokenDraft.trim()} onClick={() => { void connectors.connectSlackToken(); }}>
              {connectors.slackTokenBusy ? t`Connecting…` : t`Connect bot token`}
            </button>
            <p className="chat-hint">
              <Trans>
                Want more than one channel? Create a tiny Slack app from the ready-made manifest in{" "}
                <a href="https://github.com/haya-inc/wasmhatch/blob/main/docs/slack.md" target="_blank" rel="noreferrer">docs/slack.md</a>{" "}
                and paste its bot token: the agent can then list public channels and post to any of them.
                It still reads no messages. The token stays in this tab's memory.
              </Trans>
            </p>
          </>
        )}
        {slackTeam !== null && (
          <>
            <p className="chat-hint">
              {t`Connected to “${slackTeam}”. Every hatchling can list public channels and post to them; each post appears in the transcript.`}
            </p>
            <button className="button button-quiet" type="button" onClick={connectors.disconnectSlackToken}>
              <Trans>Disconnect bot token</Trans>
            </button>
          </>
        )}
      </section>

      <section className="chat-panel">
        <h2><Trans>Web search &amp; reading</Trans></h2>
        {!connectors.tavilyConnected && (
          <>
            <label className="chat-field">
              <span><Trans>Tavily API key (web search)</Trans></span>
              <input
                type="password"
                autoComplete="off"
                value={connectors.tavilyDraft}
                placeholder="tvly-…"
                onChange={(event) => connectors.setTavilyDraft(event.target.value)}
              />
            </label>
            <button className="button" type="button" disabled={!connectors.tavilyDraft.trim()} onClick={connectors.connectTavily}>
              <Trans>Connect web search</Trans>
            </button>
            <p className="chat-hint">
              <Trans>
                Claude and OpenRouter search from the provider's own side — this key is the fallback that
                gives every other provider (Chrome built-in, Ollama, OpenAI) a web_search tool. A free key
                takes a minute at tavily.com. It goes only to api.tavily.com and stays in this tab's memory.
              </Trans>
            </p>
          </>
        )}
        {connectors.tavilyConnected && (
          <>
            <p className="chat-hint">
              <Trans>Web search connected. Providers without their own search now get a web_search tool; each search spends your Tavily quota.</Trans>
            </p>
            <button className="button button-quiet" type="button" onClick={connectors.disconnectTavily}>
              <Trans>Disconnect web search</Trans>
            </button>
          </>
        )}
        {!connectors.jinaConnected && (
          <>
            <label className="chat-field">
              <span><Trans>Jina API key (page reading)</Trans></span>
              <input
                type="password"
                autoComplete="off"
                value={connectors.jinaDraft}
                placeholder="jina_…"
                onChange={(event) => connectors.setJinaDraft(event.target.value)}
              />
            </label>
            <button className="button" type="button" disabled={!connectors.jinaDraft.trim()} onClick={connectors.connectJina}>
              <Trans>Connect page reading</Trans>
            </button>
            <p className="chat-hint">
              <Trans>
                Lets any hatchling read one specific page as clean text with fetch_page — for example a
                promising search result. A free key takes a minute at jina.ai. Page URLs go through
                r.jina.ai; the key stays in this tab's memory.
              </Trans>
            </p>
          </>
        )}
        {connectors.jinaConnected && (
          <>
            <p className="chat-hint">
              <Trans>Page reading connected. Every hatchling can read a specific URL with fetch_page.</Trans>
            </p>
            <button className="button button-quiet" type="button" onClick={connectors.disconnectJina}>
              <Trans>Disconnect page reading</Trans>
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
                  <button type="button" onClick={() => { void onOpenFile(path); }}>{path}</button>
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

      <section className="chat-panel">
        <h2><Trans>Run journal</Trans></h2>
        {journal && journal.events.length > 0
          ? (
            <>
              <p className="chat-hint">
                {t`${journal.events.length} events · ${journal.metrics.toolCalls} tool calls · ${journal.metrics.commits} writes`}
              </p>
              <ol className="chat-journal">
                {journal.events.slice(-5).map((event) => (
                  <li key={event.sequence}>
                    <span className="chat-journal-seq">{event.sequence}</span> {event.summary}
                  </li>
                ))}
              </ol>
              <button className="button" type="button" onClick={exportJournal}>
                <Trans>Export JSON</Trans>
              </button>
            </>
          )
          : (
            <p className="chat-hint">
              <Trans>
                A structured, exportable record of this hatchling's runs — model turns, tool calls, and
                writes, with credentials always excluded. It stays in this tab until you export it.
              </Trans>
            </p>
          )}
      </section>

      <section className="chat-panel">
        <h2><Trans>Portable agents</Trans></h2>
        <label className="button chat-file-button">
          <Trans>Import a .agent file</Trans>
          <input
            type="file"
            accept=".agent,application/zip"
            aria-label={t`Import portable agent file`}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void portable.importPortableFile(file);
            }}
          />
        </label>
        <button className="button" type="button" disabled={portable.portableBusy || !selected} onClick={() => { void portable.exportPortable(); }}>
          <Trans>Export this hatchling</Trans>
        </button>
        {registryBaseUrl() && (
          <>
            <label className="chat-field">
              <span><Trans>Registry package URL</Trans></span>
              <input
                type="text"
                value={portable.registryLoadUrl}
                placeholder={`${registryBaseUrl()}/v1/agents/…/package`}
                onChange={(event) => portable.setRegistryLoadUrl(event.target.value)}
              />
            </label>
            <button className="button" type="button" disabled={portable.portableBusy || !portable.registryLoadUrl.trim()} onClick={() => { void portable.loadPortableFromRegistry(); }}>
              <Trans>Load from the registry</Trans>
            </button>
            <label className="chat-field">
              <span><Trans>Publish token</Trans></span>
              <input
                type="password"
                autoComplete="off"
                value={portable.registryToken}
                onChange={(event) => portable.setRegistryToken(event.target.value)}
              />
            </label>
            <button className="button" type="button" disabled={portable.portableBusy || !portable.registryToken.trim() || !selected} onClick={() => { void portable.publishPortable(); }}>
              <Trans>Publish this hatchling</Trans>
            </button>
          </>
        )}
        <p className="chat-hint">
          <Trans>
            A hatchling travels as one .agent file: its playbook, starter files, and requested
            capabilities — never credentials or chat history. Importing always shows a preview first,
            and packaged instructions can never unlock more than you see there.
          </Trans>
        </p>
      </section>

      {viewer && (
        <section className="chat-panel">
          <h2>{viewer.path}</h2>
          <pre className="chat-viewer">{viewer.content}</pre>
          <button className="button button-quiet" type="button" onClick={() => downloadTextFile(viewer.path, viewer.content)}><Trans>Download</Trans></button>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => { void copyToClipboard(); }}
            disabled={!clipboardAvailable}
            title={clipboardAvailable ? undefined : t`Clipboard API is not available in this browser.`}
          >
            {copied ? t`Copied` : t`Copy`}
          </button>
          <button className="button button-quiet" type="button" onClick={onCloseViewer}><Trans>Close</Trans></button>
        </section>
      )}

      <ArtifactPanel artifact={artifact} onClose={onCloseArtifact} />
    </aside>
  );
}
