import { useCallback, useEffect } from "react";
import {
  ARTIFACT_IFRAME_CSP,
  ARTIFACT_IFRAME_SANDBOX,
  artifactDownloadName,
  withInjectedCsp,
  type HtmlArtifact
} from "../lib/artifact";

export function ArtifactPanel({ artifact, onClose }: { artifact: HtmlArtifact | null; onClose: () => void }) {
  useEffect(() => {
    if (!artifact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [artifact, onClose]);

  const download = useCallback(() => {
    if (!artifact) return;
    const url = URL.createObjectURL(new Blob([artifact.html], { type: "text/html" }));
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifactDownloadName(artifact.title);
      anchor.rel = "noopener";
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [artifact]);

  if (!artifact) return null;

  return (
    <section className="artifact-panel" aria-label={`Artifact: ${artifact.title}`}>
      <header className="artifact-header">
        <h2>{artifact.title}</h2>
        <div className="artifact-header-actions">
          <button className="button" type="button" onClick={download}>Download</button>
          <button className="button button-quiet" type="button" onClick={onClose}>Close</button>
        </div>
      </header>
      <iframe
        className="artifact-frame"
        title={artifact.title}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={withInjectedCsp(artifact.html, ARTIFACT_IFRAME_CSP)}
      />
      <p className="artifact-note">
        Runs isolated from the app: no cookies, no storage, no network. Download to keep it.
      </p>
    </section>
  );
}
