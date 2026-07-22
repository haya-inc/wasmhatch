/**
 * Google Picker — file handover as a visible consent step.
 *
 * drive.file is per-file: the agent reaches only files it created plus files
 * the user hands over through Google's own picker UI. This module loads the
 * picker (gapi) on demand — same singleton-loader shape as
 * `loadGoogleIdentityServices` — and opens a file picker that resolves with
 * the picked files or null on cancel. Folder handover is deliberately NOT
 * offered: the spike in spikes/picker exists to prove whether a folder pick
 * grants children access, and until a passing run is recorded only file
 * handover may ship (spikes/picker/README.md).
 *
 * Requires deployment config: VITE_GOOGLE_API_KEY (a public, referrer-bound
 * browser key restricted to the Picker API) and optionally
 * VITE_GOOGLE_APP_ID (the Cloud project number, recommended by Google so the
 * grant is attributed to the same project as the OAuth client).
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";

export const GOOGLE_PICKER_SCRIPT_URL = "https://apis.google.com/js/api.js";

const LOAD_TIMEOUT_MS = 15_000;
const MAX_PICKED_FILES = 16;

function readEnv(name: string): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.[name] ?? "";
}

export const GOOGLE_PICKER_API_KEY = readEnv("VITE_GOOGLE_API_KEY");
export const GOOGLE_PICKER_APP_ID = readEnv("VITE_GOOGLE_APP_ID");

export function googlePickerConfigured(): boolean {
  return Boolean(GOOGLE_PICKER_API_KEY);
}

export interface PickedDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}

interface PickerCallbackData {
  action?: unknown;
  docs?: unknown;
}

export interface GooglePickerBuilder {
  setOAuthToken(token: string): GooglePickerBuilder;
  setDeveloperKey(key: string): GooglePickerBuilder;
  setAppId(appId: string): GooglePickerBuilder;
  addView(view: unknown): GooglePickerBuilder;
  setTitle(title: string): GooglePickerBuilder;
  setCallback(callback: (data: PickerCallbackData) => void): GooglePickerBuilder;
  enableFeature(feature: unknown): GooglePickerBuilder;
  build(): { setVisible(visible: boolean): void; dispose?(): void };
}

export interface GooglePickerRuntime {
  PickerBuilder: new () => GooglePickerBuilder;
  DocsView: new (viewId?: unknown) => { setIncludeFolders(value: boolean): unknown };
  ViewId: { DOCS?: unknown };
  Action: { PICKED?: unknown; CANCEL?: unknown };
  Feature: { SUPPORT_DRIVES?: unknown; MULTISELECT_ENABLED?: unknown };
}

class GooglePickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GooglePickerError";
  }
}

function pickerRuntimeFromGlobal(): GooglePickerRuntime | null {
  const candidate = (globalThis as {
    google?: { picker?: Partial<GooglePickerRuntime> };
  }).google?.picker;
  if (candidate && typeof candidate.PickerBuilder === "function" && typeof candidate.DocsView === "function") {
    return candidate as GooglePickerRuntime;
  }
  return null;
}

interface GapiLoader {
  load(module: string, options: { callback(): void; onerror?(): void; timeout?: number; ontimeout?(): void }): void;
}

let runtimePromise: Promise<GooglePickerRuntime> | null = null;

function loadGapiScript(): Promise<GapiLoader> {
  return new Promise((resolve, reject) => {
    const existing = (globalThis as { gapi?: GapiLoader }).gapi;
    if (existing && typeof existing.load === "function") {
      resolve(existing);
      return;
    }
    if (typeof document === "undefined") {
      reject(new GooglePickerError("The Google Picker requires a browser document."));
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_PICKER_SCRIPT_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GOOGLE_PICKER_SCRIPT_URL;
      script.async = true;
      script.referrerPolicy = "no-referrer";
      document.head.append(script);
    }
    let settled = false;
    const finish = (loader?: GapiLoader, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (loader) resolve(loader);
      else reject(error ?? new GooglePickerError("The Google Picker script could not be loaded."));
    };
    const timer = globalThis.setTimeout(() => finish(undefined, new GooglePickerError("The Google Picker script did not load in time.")), LOAD_TIMEOUT_MS);
    script.addEventListener("load", () => {
      const loader = (globalThis as { gapi?: GapiLoader }).gapi;
      if (loader && typeof loader.load === "function") finish(loader);
      else finish(undefined, new GooglePickerError("The Google Picker script loaded without gapi."));
    }, { once: true });
    script.addEventListener("error", () => {
      script?.remove();
      finish(undefined, new GooglePickerError("The Google Picker script could not be loaded."));
    }, { once: true });
  });
}

export function loadGooglePickerRuntime(): Promise<GooglePickerRuntime> {
  const existing = pickerRuntimeFromGlobal();
  if (existing) return Promise.resolve(existing);
  if (runtimePromise) return runtimePromise;
  runtimePromise = loadGapiScript()
    .then((gapi) => new Promise<GooglePickerRuntime>((resolve, reject) => {
      gapi.load("picker", {
        callback: () => {
          const runtime = pickerRuntimeFromGlobal();
          if (runtime) resolve(runtime);
          else reject(new GooglePickerError("The Google Picker module loaded without its API."));
        },
        onerror: () => reject(new GooglePickerError("The Google Picker module failed to load.")),
        timeout: LOAD_TIMEOUT_MS,
        ontimeout: () => reject(new GooglePickerError("The Google Picker module did not load in time."))
      });
    }))
    .catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}

function parsePickedDocs(value: unknown): PickedDriveFile[] {
  if (!Array.isArray(value)) return [];
  const files: PickedDriveFile[] = [];
  for (const entry of value.slice(0, MAX_PICKED_FILES)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; mimeType?: unknown };
    if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{10,256}$/.test(record.id)) continue;
    files.push({
      id: record.id,
      name: typeof record.name === "string" && record.name ? record.name.slice(0, 256) : "(unnamed)",
      mimeType: typeof record.mimeType === "string" && record.mimeType ? record.mimeType.slice(0, 128) : "(unknown)"
    });
  }
  return files;
}

/**
 * Opens the Google file picker (must be called from a user gesture).
 * Resolves with the picked files, or null when the user cancels.
 */
export async function openDriveFilePicker(options: {
  accessToken: string;
  apiKey: string;
  appId?: string;
  title?: string;
  loadRuntime?: () => Promise<GooglePickerRuntime>;
}): Promise<PickedDriveFile[] | null> {
  if (!options.accessToken.trim()) throw new GooglePickerError("The Google Picker needs a connected Google session.");
  if (!options.apiKey.trim()) throw new GooglePickerError("The Google Picker needs a configured browser API key.");
  const runtime = await (options.loadRuntime ?? loadGooglePickerRuntime)();
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const view = new runtime.DocsView(runtime.ViewId.DOCS);
      view.setIncludeFolders(true);
      const builder = new runtime.PickerBuilder()
        .setOAuthToken(options.accessToken)
        .setDeveloperKey(options.apiKey)
        .addView(view)
        .setTitle(options.title ?? "Hand files to WasmHatch")
        .enableFeature(runtime.Feature.MULTISELECT_ENABLED)
        .enableFeature(runtime.Feature.SUPPORT_DRIVES)
        .setCallback((data) => {
          if (settled) return;
          if (data.action === runtime.Action.CANCEL) {
            settled = true;
            resolve(null);
            return;
          }
          if (data.action !== runtime.Action.PICKED) return;
          settled = true;
          resolve(parsePickedDocs(data.docs));
        });
      if (options.appId?.trim()) builder.setAppId(options.appId.trim());
      builder.build().setVisible(true);
    } catch {
      if (!settled) {
        settled = true;
        reject(new GooglePickerError("The Google Picker could not be opened."));
      }
    }
  });
}

export const GOOGLE_PICKER_TOOL: AgentToolDefinition = {
  name: "open_google_file_picker",
  description:
    "Ask the user to hand over existing Google Drive files. This opens Google's own file picker as a " +
    "visible consent step — the user chooses files or declines — and returns the picked files' id, name, " +
    "and mimeType. Handed-over files become readable and editable through the existing Google tools. " +
    "Use it when the task needs a file WasmHatch did not create; you still cannot browse Drive yourself.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "One short sentence shown to the user explaining why you need a file." }
    },
    required: [],
    additionalProperties: false
  }
};

/**
 * Creates the executor for GOOGLE_PICKER_TOOL. `requestFilePick` is the UI
 * bridge: it shows the consent card, opens the picker on the user's click,
 * and resolves with the picked files (or null when the user declines).
 */
export function createGooglePickerExecutor(
  requestFilePick: (reason: string, signal?: AbortSignal) => Promise<PickedDriveFile[] | null>
): AgentToolExecutor {
  return async (name, args, context): Promise<AgentToolOutcome> => {
    if (name !== GOOGLE_PICKER_TOOL.name) {
      return { content: `Unknown Google picker tool: ${name}`, isError: true };
    }
    const reasonRaw = (args as { reason?: unknown }).reason;
    const reason = typeof reasonRaw === "string" ? reasonRaw.slice(0, 300) : "";
    const files = await requestFilePick(reason, context?.signal);
    if (!files || files.length === 0) {
      return { content: "The user declined the file handover (or picked nothing). Continue without those files, or explain what you would need them for." };
    }
    return {
      content: `The user handed over ${files.length} Google Drive file(s):\n${files
        .map((file) => `${file.id}  ${file.name}  (${file.mimeType})`)
        .join("\n")}\nThese files are now accessible to the Google tools.`
    };
  };
}
