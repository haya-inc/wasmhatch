import type {
  BusinessScriptLimits,
  BusinessScriptResult,
  BusinessValue
} from "./business-script";

interface ScriptWorkerSuccess {
  id: string;
  ok: true;
  result: BusinessScriptResult;
}

interface ScriptWorkerFailure {
  id: string;
  ok: false;
  error: string;
}

type ScriptWorkerResponse = ScriptWorkerSuccess | ScriptWorkerFailure;

export async function runBusinessScriptInWorker(
  source: string,
  input: BusinessValue,
  options: { limits?: BusinessScriptLimits; signal?: AbortSignal; wallTimeoutMs?: number } = {}
) {
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const worker = new Worker(new URL("./business-script.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  const wallTimeoutMs = options.wallTimeoutMs ?? 15_000;

  return new Promise<BusinessScriptResult>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Sandbox worker did not finish before its wall-clock limit."));
    }, wallTimeoutMs);

    worker.onmessage = (event: MessageEvent<ScriptWorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("Sandbox worker failed to start."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ id, source, input, limits: options.limits });
  });
}
