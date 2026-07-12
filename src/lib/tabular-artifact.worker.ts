/// <reference lib="webworker" />

import { exportTabularArtifact, importTabularArtifact } from "./tabular-artifact";
import type { TabularArtifactFormat, TabularArtifactInput } from "./tabular-artifact-contract";
import type { SpreadsheetRows } from "./spreadsheet";

declare const self: DedicatedWorkerGlobalScope;

interface ImportRequest extends Omit<TabularArtifactInput, "bytes"> {
  action: "import";
  id: string;
  bytes: ArrayBuffer;
}

interface ExportRequest {
  action: "export";
  id: string;
  rows: SpreadsheetRows;
  format: TabularArtifactFormat;
  baseName: string;
}

self.onmessage = (event: MessageEvent<ImportRequest | ExportRequest>) => {
  const request = event.data;
  if (request.action === "export") {
    try {
      const artifact = exportTabularArtifact(request.rows, request.format, request.baseName);
      const bytes = artifact.bytes.buffer as ArrayBuffer;
      self.postMessage({ id: request.id, ok: true, artifact: { ...artifact, bytes } }, [bytes]);
    } catch (error: unknown) {
      self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : "Tabular artifact export failed." });
    }
    return;
  }
  void importTabularArtifact({ ...request, bytes: new Uint8Array(request.bytes) }).then(
    (snapshot) => self.postMessage({ id: request.id, ok: true, snapshot }),
    (error: unknown) => self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Tabular artifact import failed."
    })
  );
};
