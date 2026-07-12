/// <reference lib="webworker" />

import { executeBusinessScript, type BusinessScriptLimits, type BusinessValue } from "./business-script";
import { executeWorkspaceScript } from "./workspace-script-runtime";
import type { WorkspaceScriptRunSnapshot } from "./workspace-script";

interface TransformScriptWorkerRequest {
  kind?: "transform";
  id: string;
  source: string;
  input: BusinessValue;
  limits?: BusinessScriptLimits;
}

interface WorkspaceScriptWorkerRequest {
  kind: "workspace";
  id: string;
  snapshot: WorkspaceScriptRunSnapshot;
}

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<TransformScriptWorkerRequest | WorkspaceScriptWorkerRequest>) => {
  const request = event.data;
  const execution = request.kind === "workspace"
    ? executeWorkspaceScript(request.snapshot)
    : executeBusinessScript(request.source, request.input, request.limits);
  void execution
    .then((result) => worker.postMessage({ id: request.id, ok: true, result }))
    .catch((error: unknown) => worker.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Sandbox script failed."
    }));
};

export {};
