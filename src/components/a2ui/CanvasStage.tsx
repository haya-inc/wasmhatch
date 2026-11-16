import "../../lib/a2ui/dom-polyfill-guard";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { A2uiSurface } from "@a2ui/react";
import { Check, Copy, Download, X } from "lucide-react";
import { A2uiFormBoundary } from "../../lib/a2ui/basic-catalog-react";
import { A2uiSurfaceRpcContext } from "../../lib/a2ui/rpc-functions";
import type { CanvasSurfaceEntry } from "../../lib/a2ui/runtime";
import type { HtmlArtifact } from "../../lib/artifact";
import { downloadTextFile } from "../../lib/browser-download";
import { ArtifactPanel } from "../ArtifactPanel";

const ARTIFACT_TAB_KEY = "__html_artifact__";

function StageTabPanel({
  tabId,
  selected,
  onReveal,
  children
}: {
  tabId: string;
  selected: boolean;
  onReveal: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (selected) {
      el.removeAttribute("hidden");
    } else {
      el.setAttribute("hidden", "until-found");
    }
  }, [selected]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const handleBeforeMatch = () => onReveal();
    el.addEventListener("beforematch", handleBeforeMatch);
    return () => el.removeEventListener("beforematch", handleBeforeMatch);
  }, [onReveal]);

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby={tabId}
      className="canvas-tabpanel"
      hidden={!selected}
    >
      <div className="canvas-tabpanel-body">{children}</div>
    </div>
  );
}

export interface CanvasStageProps {
  surfaces: readonly CanvasSurfaceEntry[];
  activeSurfaceId: string | null;
  onSelectSurface: (surfaceId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
  onExportSurface?: (surfaceId: string) => { fileName: string; title: string; html: string } | null;
  artifact: HtmlArtifact | null;
  onCloseArtifact: () => void;
}

export function CanvasStage({
  surfaces,
  activeSurfaceId,
  onSelectSurface,
  onCloseSurface,
  onExportSurface,
  artifact,
  onCloseArtifact
}: CanvasStageProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const toolbarRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [toolbarFocusIndex, setToolbarFocusIndex] = useState(0);
  const [copiedSurfaceId, setCopiedSurfaceId] = useState<string | null>(null);
  const [toolbarAnnouncement, setToolbarAnnouncement] = useState("");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [preferArtifact, setPreferArtifact] = useState(false);
  const lastArtifactKeyRef = useRef<string | null>(null);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  // Auto-focus a newly generated HTML artifact tab when `createdIndex` advances.
  useEffect(() => {
    const nextKey = artifact ? `${artifact.id}:${artifact.createdIndex}` : null;
    if (nextKey && nextKey !== lastArtifactKeyRef.current) {
      setPreferArtifact(true);
    } else if (!nextKey) {
      setPreferArtifact(false);
    }
    lastArtifactKeyRef.current = nextKey;
  }, [artifact]);

  // If the user explicitly selects or pins a Canvas surface, switch focus to it.
  const prevSurfaceIdRef = useRef<string | null>(activeSurfaceId);
  useEffect(() => {
    if (activeSurfaceId && activeSurfaceId !== prevSurfaceIdRef.current) {
      setPreferArtifact(false);
    }
    prevSurfaceIdRef.current = activeSurfaceId;
  }, [activeSurfaceId]);

  const items = useMemo(() => {
    const list: Array<
      | { key: string; kind: "surface"; title: string; entry: CanvasSurfaceEntry }
      | { key: string; kind: "artifact"; title: string; artifact: HtmlArtifact }
    > = surfaces.map((entry) => ({
      key: `surface:${entry.surfaceId}`,
      kind: "surface",
      title: entry.title,
      entry
    }));
    if (artifact) {
      list.push({
        key: ARTIFACT_TAB_KEY,
        kind: "artifact",
        title: artifact.title,
        artifact
      });
    }
    return list;
  }, [artifact, surfaces]);

  const selectedIndex = useMemo(() => {
    if (items.length === 0) return 0;
    if (preferArtifact && artifact) {
      const artifactIdx = items.findIndex((item) => item.key === ARTIFACT_TAB_KEY);
      if (artifactIdx >= 0) return artifactIdx;
    }
    if (activeSurfaceId) {
      const idx = items.findIndex((item) => item.key === `surface:${activeSurfaceId}`);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [activeSurfaceId, artifact, items, preferArtifact]);

  const activateIndex = useCallback((index: number, focusTab: boolean) => {
    const target = items[index];
    if (!target) return;
    if (target.kind === "artifact") {
      setPreferArtifact(true);
    } else {
      setPreferArtifact(false);
      onSelectSurface(target.entry.surfaceId);
    }
    if (focusTab) {
      tabRefs.current[index]?.focus();
    }
  }, [items, onSelectSurface]);

  const onTabListKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length <= 1) return;
    let next = -1;
    if (event.key === "ArrowRight") next = (selectedIndex + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (selectedIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next >= 0) {
      event.preventDefault();
      activateIndex(next, true);
    }
  }, [activateIndex, items.length, selectedIndex]);

  const onToolbarKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) {
      return;
    }
    const buttons = toolbarRefs.current.filter((btn): btn is HTMLButtonElement => Boolean(btn && !btn.disabled));
    if (buttons.length <= 1) return;
    const currentIdx = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    let next = -1;
    if (event.key === "ArrowRight") next = (currentIdx + 1) % buttons.length;
    else if (event.key === "ArrowLeft") next = (currentIdx - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next >= 0) {
      event.preventDefault();
      const targetBtn = buttons[next];
      const rawIdx = toolbarRefs.current.indexOf(targetBtn);
      if (rawIdx >= 0) setToolbarFocusIndex(rawIdx);
      targetBtn?.focus();
    }
  }, []);

  const handleExportHtml = useCallback(
    (surfaceId: string) => {
      const exported = onExportSurface?.(surfaceId);
      if (!exported) return;
      downloadTextFile(exported.fileName, exported.html, "text/html");
      setToolbarAnnouncement(t`Exported ${exported.fileName}`);
    },
    [onExportSurface]
  );

  const handleCopyHtml = useCallback(
    async (surfaceId: string) => {
      const exported = onExportSurface?.(surfaceId);
      if (!exported || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(exported.html);
        setCopiedSurfaceId(surfaceId);
        setToolbarAnnouncement(t`Copied standalone HTML to clipboard`);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedSurfaceId(null), 2_000);
      } catch {
        setToolbarAnnouncement(t`Could not copy HTML to clipboard`);
      }
    },
    [onExportSurface]
  );

  if (items.length === 0) return null;

  const activeItem = items[selectedIndex] ?? items[0];
  const isCopied =
    activeItem.kind === "surface" && copiedSurfaceId === activeItem.entry.surfaceId;

  return (
    <aside className="canvas-stage" aria-label={t`Canvas`}>
      <header className="canvas-stage-header">
        <div
          className="canvas-tablist"
          role="tablist"
          aria-label={t`Canvas`}
          onKeyDown={onTabListKeyDown}
          {...({ focusgroup: "tablist nomemory" } as Record<string, unknown>)}
        >
          {items.map((item, index) => {
            const selected = index === selectedIndex;
            const tabId = `${baseId}-tab-${index}`;
            return (
              <button
                key={item.key}
                ref={(el) => { tabRefs.current[index] = el; }}
                id={tabId}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="canvas-tab"
                onClick={() => activateIndex(index, false)}
                {...(selected ? ({ focusgroupstart: "" } as Record<string, unknown>) : {})}
              >
                {item.title}
              </button>
            );
          })}
        </div>
        {activeItem.kind === "surface" && (
          <div
            className="canvas-toolbar"
            role="toolbar"
            aria-label={t`Canvas actions`}
            onKeyDown={onToolbarKeyDown}
            {...({ focusgroup: "toolbar wrap" } as Record<string, unknown>)}
          >
            {onExportSurface && (
              <>
                <button
                  ref={(el) => { toolbarRefs.current[0] = el; }}
                  type="button"
                  tabIndex={toolbarFocusIndex === 0 ? 0 : -1}
                  className="button button-quiet canvas-close-btn"
                  onFocus={() => setToolbarFocusIndex(0)}
                  onClick={() => handleExportHtml(activeItem.entry.surfaceId)}
                >
                  <Download size={14} aria-hidden="true" />
                  <span><Trans>Export HTML</Trans></span>
                </button>
                <button
                  ref={(el) => { toolbarRefs.current[1] = el; }}
                  type="button"
                  tabIndex={toolbarFocusIndex === 1 ? 0 : -1}
                  className="button button-quiet canvas-close-btn"
                  onFocus={() => setToolbarFocusIndex(1)}
                  onClick={() => { void handleCopyHtml(activeItem.entry.surfaceId); }}
                >
                  {isCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  <span>{isCopied ? <Trans>Copied</Trans> : <Trans>Copy HTML</Trans>}</span>
                </button>
              </>
            )}
            <button
              ref={(el) => { toolbarRefs.current[onExportSurface ? 2 : 0] = el; }}
              type="button"
              tabIndex={toolbarFocusIndex === (onExportSurface ? 2 : 0) ? 0 : -1}
              className="button button-quiet canvas-close-btn"
              aria-label={t`Close`}
              title={t`Close`}
              onFocus={() => setToolbarFocusIndex(onExportSurface ? 2 : 0)}
              onClick={() => onCloseSurface(activeItem.entry.surfaceId)}
            >
              <X size={15} aria-hidden="true" />
              <span><Trans>Close</Trans></span>
            </button>
            <span className="a2ui-sr-only" role="status" aria-live="polite">
              {toolbarAnnouncement}
            </span>
          </div>
        )}
      </header>

      <div className="canvas-stage-panels">
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          const tabId = `${baseId}-tab-${index}`;
          return (
            <StageTabPanel
              key={item.key}
              tabId={tabId}
              selected={selected}
              onReveal={() => activateIndex(index, false)}
            >
              {item.kind === "artifact" ? (
                <ArtifactPanel artifact={item.artifact} onClose={onCloseArtifact} />
              ) : (
                <div className="a2ui-surface-root a2ui-canvas-surface-body">
                  <A2uiSurfaceRpcContext.Provider value={item.entry.rpcBridge}>
                    <A2uiFormBoundary>
                      <A2uiSurface surface={item.entry.surface} />
                    </A2uiFormBoundary>
                  </A2uiSurfaceRpcContext.Provider>
                </div>
              )}
            </StageTabPanel>
          );
        })}
      </div>
    </aside>
  );
}
