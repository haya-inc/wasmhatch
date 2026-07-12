import {
  TABULAR_ARTIFACT_LIMITS,
  type TabularArtifactExport,
  type TabularArtifactFormat,
  type TabularArtifactSnapshot
} from "./tabular-artifact-contract";
import type { SpreadsheetRows } from "./spreadsheet";

const IMPORT_TIMEOUT_MS = 8_000;

interface WorkerResponse {
  id: string;
  ok: boolean;
  snapshot?: TabularArtifactSnapshot;
  artifact?: Omit<TabularArtifactExport, "bytes"> & { bytes: ArrayBuffer };
  error?: string;
}

export async function importTabularArtifactInWorker(file: File, sheetName?: string) {
  if (!file.size) throw new Error("The selected file is empty.");
  if (file.size > TABULAR_ARTIFACT_LIMITS.sourceBytes) {
    throw new Error("The selected file exceeds the 8 MB compressed input limit.");
  }
  const bytes = await file.arrayBuffer();
  const worker = new Worker(new URL("./tabular-artifact.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  return new Promise<TabularArtifactSnapshot>((resolve, reject) => {
    const finish = (callback: () => void) => {
      window.clearTimeout(timeout);
      worker.terminate();
      callback();
    };
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Tabular artifact import exceeded the 8 second limit."))),
      IMPORT_TIMEOUT_MS
    );
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.ok && response.snapshot) finish(() => resolve(response.snapshot!));
      else finish(() => reject(new Error(response.error || "Tabular artifact import failed.")));
    };
    worker.onerror = () => finish(() => reject(new Error("Tabular artifact worker failed.")));
    worker.postMessage({ action: "import", id, name: file.name, mediaType: file.type, sheetName, bytes }, [bytes]);
  });
}

export function exportTabularArtifactInWorker(
  rows: SpreadsheetRows,
  format: TabularArtifactFormat,
  baseName: string
) {
  const worker = new Worker(new URL("./tabular-artifact.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  return new Promise<TabularArtifactExport>((resolve, reject) => {
    const finish = (callback: () => void) => {
      window.clearTimeout(timeout);
      worker.terminate();
      callback();
    };
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Tabular artifact export exceeded the 8 second limit."))),
      IMPORT_TIMEOUT_MS
    );
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.ok && response.artifact) {
        const artifact = response.artifact;
        finish(() => resolve({ ...artifact, bytes: new Uint8Array(artifact.bytes) }));
      } else finish(() => reject(new Error(response.error || "Tabular artifact export failed.")));
    };
    worker.onerror = () => finish(() => reject(new Error("Tabular artifact worker failed.")));
    worker.postMessage({ action: "export", id, rows, format, baseName });
  });
}
