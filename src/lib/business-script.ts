import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline
} from "quickjs-emscripten-core";

export type BusinessValue =
  | null
  | boolean
  | number
  | string
  | BusinessValue[]
  | { [key: string]: BusinessValue };

export interface BusinessScriptLimits {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxSourceBytes?: number;
}

export interface BusinessScriptResult {
  output: BusinessValue;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

const DEFAULT_LIMITS = {
  timeoutMs: 750,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxInputBytes: 512 * 1024,
  maxOutputBytes: 512 * 1024,
  maxSourceBytes: 24 * 1024
};

let quickJsPromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

function getQuickJS() {
  quickJsPromise ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  return quickJsPromise;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function serializeJson(value: unknown, label: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable.`);
  return serialized;
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

export async function executeBusinessScript(
  source: string,
  input: BusinessValue,
  limits: BusinessScriptLimits = {}
): Promise<BusinessScriptResult> {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const normalizedSource = source.trim();
  if (!normalizedSource) throw new Error("Script source is required.");

  const sourceBytes = byteLength(normalizedSource);
  if (sourceBytes > effective.maxSourceBytes) {
    throw new Error(`Script exceeds the ${effective.maxSourceBytes}-byte source limit.`);
  }

  const serializedInput = serializeJson(input, "Script input");
  const inputBytes = byteLength(serializedInput);
  if (inputBytes > effective.maxInputBytes) {
    throw new Error(`Script input exceeds the ${effective.maxInputBytes}-byte limit.`);
  }

  const program = `
    (() => {
      "use strict";
      const input = JSON.parse(${JSON.stringify(serializedInput)});
      const transform = (${normalizedSource});
      if (typeof transform !== "function") throw new Error("Script must evaluate to a function.");
      const output = transform(input);
      if (output && typeof output.then === "function") {
        throw new Error("Async scripts are not supported in the local sandbox.");
      }
      return output;
    })()
  `;

  const startedAt = performance.now();
  try {
    const quickJs = await getQuickJS();
    const output = quickJs.evalCode(program, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + effective.timeoutMs),
      memoryLimitBytes: effective.memoryLimitBytes,
      maxStackSizeBytes: 512 * 1024
    }) as BusinessValue;
    const serializedOutput = serializeJson(output, "Script output");
    const outputBytes = byteLength(serializedOutput);
    if (outputBytes > effective.maxOutputBytes) {
      throw new Error(`Script output exceeds the ${effective.maxOutputBytes}-byte limit.`);
    }
    return {
      output,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputBytes,
      outputBytes
    };
  } catch (error) {
    const message = errorMessage(error);
    if (/interrupted/i.test(message)) throw new Error("Script exceeded its execution time limit.");
    if (/out of memory|memory limit/i.test(message)) throw new Error("Script exceeded its memory limit.");
    throw new Error(`Sandbox script failed: ${message}`);
  }
}
