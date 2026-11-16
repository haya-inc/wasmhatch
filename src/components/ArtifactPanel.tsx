import { useCallback, useEffect, useMemo, useRef } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ARTIFACT_IFRAME_CSP,
  ARTIFACT_IFRAME_SANDBOX,
  artifactDownloadName,
  withInjectedCsp,
  type HtmlArtifact
} from "../lib/artifact";
import { downloadBlob } from "../lib/browser-download";

export function ArtifactPanel({ artifact, onClose }: { artifact: HtmlArtifact | null; onClose: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const preparedHtml = useMemo(
    () => (artifact ? withInjectedCsp(artifact.html, ARTIFACT_IFRAME_CSP) : ""),
    [artifact]
  );

  const sendArtifact = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target || !preparedHtml) return;
    target.postMessage({ type: "wasmhatch:render-artifact", html: preparedHtml }, "*");
  }, [preparedHtml]);

  useEffect(() => {
    if (!artifact) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const payload = event.data as { type?: unknown } | null;
      if (payload?.type === "wasmhatch:artifact-ready") {
        sendArtifact();
      }
    };
    window.addEventListener("message", onMessage);
    sendArtifact();
    return () => window.removeEventListener("message", onMessage);
  }, [artifact, sendArtifact]);

  useEffect(() => {
    if (!artifact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [artifact, onClose]);

  const download = useCallback(() => {
    if (!artifact || !preparedHtml) return;
    downloadBlob(new Blob([preparedHtml], { type: "text/html" }), artifactDownloadName(artifact.title));
  }, [artifact, preparedHtml]);

  if (!artifact) return null;

  const sandboxUrl = `${import.meta.env.BASE_URL}artifact-sandbox.html`;

  return (
    <section className="artifact-panel" aria-label={t`Artifact: ${artifact.title}`}>
      <header className="artifact-header">
        <h2>{artifact.title}</h2>
        <div className="artifact-header-actions">
          <button className="button" type="button" onClick={download}><Trans>Download</Trans></button>
          <button className="button button-quiet" type="button" onClick={onClose}><Trans>Close</Trans></button>
        </div>
      </header>
      <iframe
        key={`${artifact.id}:${artifact.createdIndex}`}
        ref={iframeRef}
        className="artifact-frame"
        title={artifact.title}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        src={sandboxUrl}
        onLoad={sendArtifact}
      />
      <p className="artifact-note">
        <Trans>Runs isolated from the app: no cookies, no storage, no network. Download to keep it.</Trans>
      </p>
    </section>
  );
}
