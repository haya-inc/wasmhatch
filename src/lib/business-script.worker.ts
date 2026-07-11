/// <reference lib="webworker" />

import { executeBusinessScript, type BusinessScriptLimits, type BusinessValue } from "./business-script";

interface ScriptWorkerRequest {
  id: string;
  source: string;
  input: BusinessValue;
  limits?: BusinessScriptLimits;
}

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<ScriptWorkerRequest>) => {
  const request = event.data;
  void executeBusinessScript(request.source, request.input, request.limits)
    .then((result) => worker.postMessage({ id: request.id, ok: true, result }))
    .catch((error: unknown) => worker.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Sandbox script failed."
    }));
};

export {};
