import {
  evaluateQuickJsProgram,
  type BusinessValue
} from "./business-script";
import type { WorkspaceScriptRunSnapshot } from "./workspace-script";
import type { WorkspaceTextMediaType } from "./workspace-script-contract";

export interface WorkspaceScriptOutput {
  workspacePath: string;
  mountPath: string;
  mediaType: WorkspaceTextMediaType;
  content: string;
  bytes: number;
}

export interface WorkspaceScriptExecutionResult {
  runId: string;
  value: BusinessValue;
  outputs: readonly WorkspaceScriptOutput[];
  durationMs: number;
  sourceBytes: number;
  inputBytes: number;
  outputBytes: number;
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

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function executeWorkspaceScript(
  snapshot: WorkspaceScriptRunSnapshot
): Promise<WorkspaceScriptExecutionResult> {
  const inputs = Object.fromEntries(snapshot.inputs.map((input) => [input.mountPath, {
    content: input.content,
    mediaType: input.mediaType
  }]));
  const outputs = Object.fromEntries(snapshot.outputBases.map((output) => [output.mountPath, {
    maxBytes: output.maxBytes,
    required: output.required,
    mediaType: output.mediaType
  }]));
  const program = `
    (() => {
      "use strict";
      const inputFiles = JSON.parse(${JSON.stringify(JSON.stringify(inputs))});
      const outputGrants = JSON.parse(${JSON.stringify(JSON.stringify(outputs))});
      const args = JSON.parse(${JSON.stringify(JSON.stringify(snapshot.args))});
      const written = Object.create(null);
      const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
      const requirePath = (path) => {
        if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\\\") || path.includes("//")) {
          throw new Error("Virtual file path must be a normalized absolute mount path.");
        }
        const parts = path.split("/");
        if (parts.some((part, index) => index > 0 && ((index < parts.length - 1 && !part) || part === "." || part === ".."))) {
          throw new Error("Virtual file path contains an unsafe segment.");
        }
        return path;
      };
      const fs = Object.freeze({
        list(prefix = "/") {
          const normalized = requirePath(prefix);
          return [...new Set([...Object.keys(inputFiles), ...Object.keys(written)])]
            .filter((path) => path.startsWith(normalized))
            .sort();
        },
        exists(path) {
          const normalized = requirePath(path);
          return own(inputFiles, normalized) || own(written, normalized);
        },
        readText(path) {
          const normalized = requirePath(path);
          if (own(written, normalized)) return written[normalized];
          if (own(inputFiles, normalized)) return inputFiles[normalized].content;
          throw new Error("Virtual file is not granted: " + normalized);
        },
        mediaType(path) {
          const normalized = requirePath(path);
          if (own(inputFiles, normalized)) return inputFiles[normalized].mediaType;
          if (own(outputGrants, normalized)) return outputGrants[normalized].mediaType;
          throw new Error("Virtual file is not granted: " + normalized);
        },
        writeText(path, content) {
          const normalized = requirePath(path);
          if (!own(outputGrants, normalized)) throw new Error("Virtual output is not granted: " + normalized);
          if (typeof content !== "string") throw new Error("Virtual outputs must be text strings.");
          if (content.length > outputGrants[normalized].maxBytes) {
            throw new Error("Virtual output exceeds its character safety limit: " + normalized);
          }
          written[normalized] = content;
        }
      });
      const main = (${snapshot.source.trim()});
      if (typeof main !== "function") throw new Error("Workspace script must evaluate to a function.");
      const value = main(Object.freeze({ fs, args }));
      if (value && typeof value.then === "function") throw new Error("Async workspace scripts are not supported.");
      for (const path of Object.keys(outputGrants)) {
        if (outputGrants[path].required && !own(written, path)) {
          throw new Error("Required virtual output was not written: " + path);
        }
      }
      return { value, outputs: Object.keys(written).sort().map((path) => ({ mountPath: path, content: written[path] })) };
    })()
  `;

  try {
    const evaluated = await evaluateQuickJsProgram(program, {
      timeoutMs: snapshot.manifest.limits.timeoutMs,
      memoryLimitBytes: snapshot.manifest.limits.memoryLimitBytes
    });
    assertRecord(evaluated.value, "Workspace script result");
    assertExactKeys(evaluated.value, ["value", "outputs"], "Workspace script result");
    const valueJson = serializeJson(evaluated.value.value, "Workspace script return value");
    const resultBytes = byteLength(valueJson);
    if (resultBytes > snapshot.manifest.limits.maxResultBytes) {
      throw new Error(`Workspace script return value exceeds ${snapshot.manifest.limits.maxResultBytes} bytes.`);
    }
    if (!Array.isArray(evaluated.value.outputs)) throw new Error("Workspace script outputs must be an array.");
    const byMount = new Map(snapshot.outputBases.map((output) => [output.mountPath, output]));
    const seen = new Set<string>();
    const parsedOutputs = evaluated.value.outputs.map((item, index): WorkspaceScriptOutput => {
      assertRecord(item, `Workspace script output ${index + 1}`);
      assertExactKeys(item, ["mountPath", "content"], `Workspace script output ${index + 1}`);
      if (typeof item.mountPath !== "string" || typeof item.content !== "string") {
        throw new Error(`Workspace script output ${index + 1} is invalid.`);
      }
      const grant = byMount.get(item.mountPath);
      if (!grant) throw new Error(`Workspace script returned an undeclared output: ${item.mountPath}`);
      if (seen.has(item.mountPath)) throw new Error(`Workspace script returned a duplicate output: ${item.mountPath}`);
      seen.add(item.mountPath);
      const bytes = byteLength(item.content);
      if (bytes > grant.maxBytes) throw new Error(`Workspace script output ${item.mountPath} exceeds ${grant.maxBytes} bytes.`);
      return {
        workspacePath: grant.workspacePath,
        mountPath: grant.mountPath,
        mediaType: grant.mediaType,
        content: item.content,
        bytes
      };
    });
    for (const output of snapshot.outputBases) {
      if (output.required && !seen.has(output.mountPath)) {
        throw new Error(`Required workspace output was not returned: ${output.mountPath}`);
      }
    }
    const outputBytes = parsedOutputs.reduce((total, output) => total + output.bytes, 0);
    if (outputBytes > snapshot.manifest.limits.maxTotalOutputBytes) {
      throw new Error(`Workspace script outputs exceed ${snapshot.manifest.limits.maxTotalOutputBytes} total bytes.`);
    }
    return deepFreeze({
      runId: snapshot.runId,
      value: JSON.parse(valueJson) as BusinessValue,
      outputs: parsedOutputs,
      durationMs: evaluated.durationMs,
      sourceBytes: snapshot.sourceBytes,
      inputBytes: snapshot.inputs.reduce((total, input) => total + input.bytes, 0) + snapshot.argsBytes,
      outputBytes
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/^Script exceeded its (?:execution time|memory) limit\.$/.test(message)) throw new Error(message);
    throw new Error(`Workspace sandbox failed: ${message}`);
  }
}
