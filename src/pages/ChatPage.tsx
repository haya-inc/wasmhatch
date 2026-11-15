import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatTranscript, type PendingPermission } from "../components/chat/ChatTranscript";
import { TeamSidebar } from "../components/chat/TeamSidebar";
import { ToolsSidebar } from "../components/chat/ToolsSidebar";
import { useGoogleConnector } from "../components/chat/useGoogleConnector";
import { useColumnLayout, useHatchUrlSync } from "../components/chat/useHatchUrlSync";
import { usePortableAgentFlow } from "../components/chat/usePortableAgentFlow";
import { useSessionConnectors } from "../components/chat/useSessionConnectors";
import { HatchlingSwarm, type ChatItem, type RunConfig, type SwarmDeps } from "../lib/agent-session";
import type { HtmlArtifact } from "../lib/artifact";
import { detectBuiltinAiToolLoopSupport } from "../lib/builtin-ai-loop";
import type { PermissionDecision, WritePermissionRequest } from "../lib/chat-permissions";
import { getCloudProvider, type ChatProviderId } from "../lib/chat-providers";
import { loadChatSettings, saveChatSettings } from "../lib/chat-settings";
import type { WritePolicy } from "../lib/chat-tools";
import { FIRST_RUN_CSV_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "../lib/first-run-csv-sample";
import { i18n } from "../lib/i18n";
import { isProtectedAgentPath } from "../lib/secrets";
import { seedSampleFiles } from "../lib/workspace";

type BuiltinApiGetter = NonNullable<SwarmDeps["getBuiltinApi"]>;

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

export function ChatPage() {
  // Re-render the entire chat surface whenever the active Lingui catalog switches.
  useSyncExternalStore(
    useCallback((onStoreChange) => {
      i18n.on("change", onStoreChange);
      return () => { i18n.removeListener("change", onStoreChange); };
    }, []),
    () => i18n.locale,
    () => i18n.locale
  );

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
  const [columns, setColumns] = useColumnLayout();

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

  const swarmRef = useRef<HatchlingSwarm | null>(null);
  const notice = useCallback((text: string, tone: "info" | "error" = "info") => {
    const instance = swarmRef.current;
    if (instance) instance.notice(instance.selectedThreadId, text, tone);
  }, []);

  const google = useGoogleConnector(notice);
  const connectors = useSessionConnectors(notice);

  const gate = useCallback((request: WritePermissionRequest) => {
    return new Promise<PermissionDecision>((resolve) => {
      setPermissionQueue((queue) => [...queue, { request, resolve }]);
    });
  }, []);

  const [swarm] = useState(() => {
    const instance = new HatchlingSwarm({
      getConfig: () => configRef.current,
      gate,
      onArtifact: setArtifact,
      google: google.swarmDeps,
      slack: connectors.slackDeps,
      web: connectors.webDeps,
      getBuiltinApi: () => (globalThis as typeof globalThis & { LanguageModel?: ReturnType<BuiltinApiGetter> }).LanguageModel
    });
    swarmRef.current = instance;
    return instance;
  });
  swarmRef.current = swarm;
  useEffect(() => () => swarm.dispose(), [swarm]);

  const portable = usePortableAgentFlow(swarm, notice);

  useSyncExternalStore(swarm.subscribe, swarm.getVersion, swarm.getVersion);
  const threads = swarm.listThreads();
  const selectedId = swarm.selectedThreadId;
  const selected = swarm.getState(selectedId);
  const items = selected?.items ?? [];
  const running = selected?.running ?? false;

  useHatchUrlSync(swarm, selectedId);

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

  const selectedWriteCount = selected?.writeCount ?? 0;
  useEffect(() => {
    void swarm.ready.then(() => refreshFiles());
  }, [refreshFiles, selectedId, selectedWriteCount, swarm]);

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
        <ChatTranscript
          items={items}
          selected={selected}
          running={running}
          input={input}
          onInputChange={setInput}
          onSend={send}
          onStop={stop}
          onLoadSamples={loadSamples}
          onRevertWrite={revertWrite}
          permissionQueue={permissionQueue}
          onDecidePermission={decidePermission}
          pickQueue={google.pickQueue}
          activePick={google.activePick}
          pickerBusy={google.pickerBusy}
          onChooseFilesForPick={google.chooseFilesForPick}
          onDeclinePick={google.declinePick}
          portablePreview={portable.portablePreview}
          portableBusy={portable.portableBusy}
          onConfirmPortablePreview={portable.confirmPortablePreview}
          onDismissPortablePreview={portable.dismissPortablePreview}
        />

        {columns.left && (
          <TeamSidebar
            swarm={swarm}
            threads={threads}
            selectedId={selectedId}
            selected={selected}
            onNotice={notice}
          />
        )}

        {columns.right && (
          <ToolsSidebar
            swarm={swarm}
            selectedId={selectedId}
            selected={selected}
            provider={provider}
            onSwitchProvider={switchProvider}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            model={model}
            onModelChange={setModel}
            rememberKey={rememberKey}
            onRememberKeyChange={setRememberKey}
            webSearch={webSearch}
            onWebSearchChange={setWebSearch}
            writeMode={writeMode}
            onWriteModeChange={setWriteMode}
            builtinAvailability={builtinAvailability}
            google={google}
            connectors={connectors}
            portable={portable}
            files={files}
            onOpenFile={openFile}
            viewer={viewer}
            onCloseViewer={() => setViewer(null)}
            artifact={artifact}
            onCloseArtifact={() => setArtifact(null)}
            onNotice={notice}
          />
        )}
      </div>
    </div>
  );
}
