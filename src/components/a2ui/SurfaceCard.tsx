import "../../lib/a2ui/dom-polyfill-guard";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import type { SurfaceModel } from "@a2ui/web_core/v1_0";
import { Download, LayoutPanelLeft, Maximize2 } from "lucide-react";
import { A2uiFormBoundary } from "../../lib/a2ui/basic-catalog-react";
import { A2uiSurfaceRpcContext, type A2uiSurfaceRpcBridge } from "../../lib/a2ui/rpc-functions";
import { downloadTextFile } from "../../lib/browser-download";

export interface SurfaceCardProps {
  surfaceId: string;
  fallbackTitle: string;
  surface: SurfaceModel<ReactCatalogComponent> | undefined;
  rpcBridge?: A2uiSurfaceRpcBridge;
  title: string;
  inCanvas: boolean;
  isCanvasWorkbench: boolean;
  onOpenInCanvas: (surfaceId: string) => void;
  onExportHtml?: (surfaceId: string) => { fileName: string; title: string; html: string } | null;
}

export function SurfaceCard({
  surfaceId,
  fallbackTitle,
  surface,
  rpcBridge,
  title,
  inCanvas,
  isCanvasWorkbench,
  onOpenInCanvas,
  onExportHtml
}: SurfaceCardProps) {
  const displayTitle = title || fallbackTitle;
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIdx, setFocusIdx] = useState(0);

  const onToolbarKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) return;
    const buttons = actionRefs.current.filter((b): b is HTMLButtonElement => Boolean(b));
    if (buttons.length <= 1) return;
    const cur = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    let next = -1;
    if (event.key === "ArrowRight") next = (cur + 1) % buttons.length;
    else if (event.key === "ArrowLeft") next = (cur - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next >= 0) {
      event.preventDefault();
      setFocusIdx(next);
      buttons[next]?.focus();
    }
  }, []);

  if (!surface) {
    return (
      <div className="a2ui-canvas-pill a2ui-canvas-pill-muted">
        <LayoutPanelLeft size={15} aria-hidden="true" />
        <strong>{displayTitle}</strong>
      </div>
    );
  }

  if (inCanvas || isCanvasWorkbench) {
    return (
      <button
        type="button"
        className={inCanvas ? "a2ui-canvas-pill a2ui-canvas-pill-active" : "a2ui-canvas-pill"}
        onClick={() => onOpenInCanvas(surfaceId)}
      >
        <LayoutPanelLeft size={15} aria-hidden="true" />
        <strong>{displayTitle}</strong>
        <span className="a2ui-canvas-pill-action">
          {inCanvas ? <Trans>Opened in Canvas</Trans> : <Trans>Open in Canvas</Trans>}
        </span>
      </button>
    );
  }

  return (
    <section className="a2ui-inline-surface" aria-label={displayTitle}>
      <header className="a2ui-inline-header">
        <span className="a2ui-inline-title">{displayTitle}</span>
        <div
          className="a2ui-inline-toolbar"
          role="toolbar"
          aria-label={t`View actions`}
          onKeyDown={onToolbarKeyDown}
          {...({ focusgroup: "toolbar wrap" } as Record<string, unknown>)}
        >
          {onExportHtml && (
            <button
              ref={(el) => { actionRefs.current[0] = el; }}
              type="button"
              tabIndex={focusIdx === 0 ? 0 : -1}
              className="a2ui-pin-btn"
              onFocus={() => setFocusIdx(0)}
              onClick={() => {
                const exported = onExportHtml(surfaceId);
                if (exported) {
                  downloadTextFile(exported.fileName, exported.html, "text/html");
                }
              }}
            >
              <Download size={13} aria-hidden="true" />
              <span><Trans>Export HTML</Trans></span>
            </button>
          )}
          <button
            ref={(el) => { actionRefs.current[onExportHtml ? 1 : 0] = el; }}
            type="button"
            tabIndex={focusIdx === (onExportHtml ? 1 : 0) ? 0 : -1}
            className="a2ui-pin-btn"
            onFocus={() => setFocusIdx(onExportHtml ? 1 : 0)}
            onClick={() => onOpenInCanvas(surfaceId)}
          >
            <Maximize2 size={13} aria-hidden="true" />
            <span><Trans>Open in Canvas</Trans></span>
          </button>
        </div>
      </header>
      <div className="a2ui-surface-root">
        <A2uiSurfaceRpcContext.Provider value={rpcBridge ?? null}>
          <A2uiFormBoundary>
            <A2uiSurface surface={surface} />
          </A2uiFormBoundary>
        </A2uiSurfaceRpcContext.Provider>
      </div>
    </section>
  );
}
