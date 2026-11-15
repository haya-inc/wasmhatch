import { useEffect, useRef, useState } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ChatItem, HatchlingState } from "../../lib/agent-session";
import type { PermissionDecision, WritePermissionRequest } from "../../lib/chat-permissions";
import { summarizeRequestedCapabilities } from "../../lib/hatchling-capabilities";
import { AssistantMarkdown } from "./AssistantMarkdown";
import type { PendingFilePick } from "./useGoogleConnector";
import type { PortableAgentPreview } from "./usePortableAgentFlow";

export interface PendingPermission {
  request: WritePermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export interface ChatTranscriptProps {
  items: readonly ChatItem[];
  selected: HatchlingState | null;
  running: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onStop: () => void;
  onLoadSamples: () => Promise<void>;
  onRevertWrite: (item: ChatItem) => void;
  permissionQueue: readonly PendingPermission[];
  onDecidePermission: (decision: PermissionDecision) => void;
  pickQueue: readonly PendingFilePick[];
  activePick: PendingFilePick | undefined;
  pickerBusy: boolean;
  onChooseFilesForPick: () => Promise<void>;
  onDeclinePick: () => void;
  portablePreview: PortableAgentPreview | null;
  portableBusy: boolean;
  onConfirmPortablePreview: () => Promise<void>;
  onDismissPortablePreview: () => void;
}

export function ChatTranscript({
  items,
  selected,
  running,
  input,
  onInputChange,
  onSend,
  onStop,
  onLoadSamples,
  onRevertWrite,
  permissionQueue,
  onDecidePermission,
  pickQueue,
  activePick,
  pickerBusy,
  onChooseFilesForPick,
  onDeclinePick,
  portablePreview,
  portableBusy,
  onConfirmPortablePreview,
  onDismissPortablePreview
}: ChatTranscriptProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const activePermission = permissionQueue[0];

  // Track which tool-call IDs have been announced to avoid duplicate screen-reader spam.
  const announcedToolIds = useRef<Set<string>>(new Set());

  // Build the live-region announcement text from tool items that changed state.
  const [toolAnnouncement, setToolAnnouncement] = useState("");
  const announcementClearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    for (const item of items) {
      if (item.kind !== "tool" || item.toolState === "running") continue;
      const key = item.callId ?? `${item.id}`;
      if (announcedToolIds.current.has(key)) continue;
      announcedToolIds.current.add(key);
      const stateLabel = item.toolState === "error" ? t`failed` : t`done`;
      setToolAnnouncement(`${item.text} — ${stateLabel}`);
      // Clear after a short delay so the same announcement won't re-fire on the next render.
      clearTimeout(announcementClearTimer.current);
      announcementClearTimer.current = setTimeout(() => setToolAnnouncement(""), 2000);
      break; // announce one at a time
    }
  }, [items]);
  useEffect(() => () => clearTimeout(announcementClearTimer.current), []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items.length, permissionQueue, pickQueue]);

  return (
    <main className="chat-main">
      <div className="chat-transcript" ref={listRef}>
        {/* Screen-reader announcements for tool-chip state transitions */}
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}
        >
          {toolAnnouncement}
        </div>
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
            <p className="chat-empty-note">
              <Trans>
                Runs in this browser tab with your API key, local Ollama, or Chrome’s built-in AI — no WasmHatch server in between.
              </Trans>
            </p>
            <div className="chat-empty-actions">
              <button className="button" type="button" onClick={() => { void onLoadSamples(); }}>
                <Trans>Add a sample spreadsheet</Trans>
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => onInputChange(t`Build a clean one-page HTML status dashboard from the files in this workspace.`)}
              >
                <Trans>Try an HTML report prompt</Trans>
              </button>
            </div>
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
                  <button className="button button-quiet" type="button" onClick={() => { onRevertWrite(item); }}>
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
              <button className="button button-primary" type="button" onClick={() => onDecidePermission("allow-once")}>
                <Trans>Allow once</Trans>
              </button>
              <button className="button" type="button" onClick={() => onDecidePermission("always-allow")}>
                <Trans>Always allow this file</Trans>
              </button>
              <button className="button button-quiet" type="button" onClick={() => onDecidePermission("reject")}>
                <Trans>Reject</Trans>
              </button>
            </div>
          </section>
        )}

        {activePick && (
          <section className="chat-permission" aria-label={t`Google file handover requested`}>
            <h2><Trans>Hand Google Drive files to the agent?</Trans></h2>
            <p className="chat-permission-meta">
              {activePick.reason
                ? activePick.reason
                : t`The agent asked for existing Google files it cannot see on its own.`}
            </p>
            <p className="chat-permission-meta">
              <Trans>Google's own picker opens next — only the files you choose there are shared.</Trans>
            </p>
            <div className="chat-permission-actions">
              <button className="button button-primary" type="button" disabled={pickerBusy} onClick={() => { void onChooseFilesForPick(); }}>
                {pickerBusy ? t`Opening…` : t`Choose files…`}
              </button>
              <button className="button button-quiet" type="button" disabled={pickerBusy} onClick={onDeclinePick}>
                <Trans>Decline</Trans>
              </button>
            </div>
          </section>
        )}

        {portablePreview && (() => {
          const manifest = portablePreview.pkg.manifest;
          const capabilities = summarizeRequestedCapabilities(manifest.permissions.tools);
          return (
            <section className="chat-permission" aria-label={t`Portable agent preview`}>
              <h2>
                {portablePreview.action === "publish"
                  ? t`Publish “${manifest.name}”?`
                  : t`Hatch “${manifest.name}”?`}
              </h2>
              <p className="chat-permission-meta">
                {manifest.id}@{manifest.version} · {manifest.license} · {portablePreview.source}
              </p>
              <p className="chat-permission-meta">{manifest.summary}</p>
              <p className="chat-permission-meta">
                {t`${manifest.files.length} files:`}{" "}
                {manifest.files.slice(0, 8).map((file) => file.path).join(", ")}
                {manifest.files.length > 8 ? "…" : ""}
              </p>
              <p className="chat-permission-meta">
                {capabilities.known.length
                  ? t`Requested capabilities: ${capabilities.known.join(", ")}`
                  : t`Requested capabilities: none — it can only talk.`}
                {capabilities.unknown.length > 0 && ` ${t`Unrecognized requests (granted nothing): ${capabilities.unknown.join(", ")}`}`}
              </p>
              <p className="chat-permission-meta">
                <Trans>Packaged instructions are treated as untrusted content: they never see your keys and only the capabilities above are available.</Trans>
              </p>
              <div className="chat-permission-actions">
                <button className="button button-primary" type="button" disabled={portableBusy} onClick={() => { void onConfirmPortablePreview(); }}>
                  {portablePreview.action === "publish"
                    ? (portableBusy ? t`Publishing…` : t`Publish it`)
                    : (portableBusy ? t`Hatching…` : t`Hatch it`)}
                </button>
                <button className="button button-quiet" type="button" disabled={portableBusy} onClick={onDismissPortablePreview}>
                  <Trans>Cancel</Trans>
                </button>
              </div>
            </section>
          );
        })()}
      </div>

      <div className="chat-composer">
        <textarea
          aria-label={t`Message the agent`}
          placeholder={selected ? t`Ask ${selected.thread.name} for the outcome you need…` : t`Describe the outcome you need…`}
          value={input}
          rows={3}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSend();
            }
          }}
        />
        {running
          ? <button className="button" type="button" onClick={onStop}><Trans>Stop</Trans></button>
          : <button className="button button-primary" type="button" disabled={!input.trim()} onClick={() => { void onSend(); }}><Trans>Send</Trans></button>}
      </div>
    </main>
  );
}
