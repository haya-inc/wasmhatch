import type { WorkspaceScriptExecutionResult } from "./workspace-script-runtime";
import type { WorkspaceScriptRunSnapshot } from "./workspace-script";

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: WorkspaceScriptExecutionResult;
  error?: string;
}

export function runWorkspaceScriptInWorker(
  snapshot: WorkspaceScriptRunSnapshot,
  options: { signal?: AbortSignal; wallTimeoutMs?: number } = {}
) {
  if (options.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const worker = new Worker(new URL("./business-script.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  const wallTimeoutMs = options.wallTimeoutMs ?? 15_000;
  return new Promise<WorkspaceScriptExecutionResult>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Workspace sandbox worker did not finish before its wall-clock limit."));
    }, wallTimeoutMs);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || "Workspace sandbox failed."));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("Workspace sandbox worker failed to start."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ kind: "workspace", id, snapshot });
  });
}
