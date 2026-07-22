import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_PICKER_TOOL,
  createGooglePickerExecutor,
  openDriveFilePicker,
  type GooglePickerBuilder,
  type GooglePickerRuntime,
  type PickedDriveFile
} from "./google-picker";

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUv";

function fakeRuntime(action: "picked" | "cancel" | "silent", docs?: unknown) {
  const calls: Record<string, unknown[]> = {};
  let callback: ((data: { action?: unknown; docs?: unknown }) => void) | undefined;
  const record = (name: string, value: unknown) => {
    (calls[name] ??= []).push(value);
  };
  const builder: GooglePickerBuilder = {
    setOAuthToken(token) { record("token", token); return builder; },
    setDeveloperKey(key) { record("key", key); return builder; },
    setAppId(appId) { record("appId", appId); return builder; },
    addView(view) { record("view", view); return builder; },
    setTitle(title) { record("title", title); return builder; },
    setCallback(value) { callback = value; return builder; },
    enableFeature(feature) { record("feature", feature); return builder; },
    build: () => ({
      setVisible(visible: boolean) {
        record("visible", visible);
        if (action === "picked") callback?.({ action: "picked", docs });
        else if (action === "cancel") callback?.({ action: "cancel" });
      }
    })
  };
  function PickerBuilderFake(this: unknown) {
    return builder;
  }
  function DocsViewFake(this: { setIncludeFolders: (value: boolean) => unknown }, viewId: unknown) {
    record("viewId", viewId);
    this.setIncludeFolders = (value: boolean) => {
      record("includeFolders", value);
      return this;
    };
  }
  const runtime: GooglePickerRuntime = {
    PickerBuilder: PickerBuilderFake as unknown as new () => GooglePickerBuilder,
    DocsView: DocsViewFake as unknown as GooglePickerRuntime["DocsView"],
    ViewId: { DOCS: "docs-view" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
    Feature: { SUPPORT_DRIVES: "drives", MULTISELECT_ENABLED: "multi" }
  };
  return { runtime, calls };
}

describe("openDriveFilePicker", () => {
  it("opens a multiselect docs picker bound to the session token and resolves picked files", async () => {
    const { runtime, calls } = fakeRuntime("picked", [
      { id: FILE_ID, name: "Pipeline review", mimeType: "application/vnd.google-apps.spreadsheet" },
      { id: "short" },
      { bogus: true }
    ]);
    const files = await openDriveFilePicker({
      accessToken: "google-access-token",
      apiKey: "browser-api-key",
      appId: "1234567890",
      loadRuntime: async () => runtime
    });

    expect(files).toEqual([{ id: FILE_ID, name: "Pipeline review", mimeType: "application/vnd.google-apps.spreadsheet" }]);
    expect(calls.token).toEqual(["google-access-token"]);
    expect(calls.key).toEqual(["browser-api-key"]);
    expect(calls.appId).toEqual(["1234567890"]);
    expect(calls.feature).toEqual(["multi", "drives"]);
    expect(calls.visible).toEqual([true]);
  });

  it("resolves null when the user cancels", async () => {
    const { runtime } = fakeRuntime("cancel");
    await expect(openDriveFilePicker({
      accessToken: "token",
      apiKey: "key",
      loadRuntime: async () => runtime
    })).resolves.toBeNull();
  });

  it("requires a token and an API key before loading anything", async () => {
    const loadRuntime = vi.fn();
    await expect(openDriveFilePicker({ accessToken: " ", apiKey: "key", loadRuntime })).rejects.toThrow("connected Google session");
    await expect(openDriveFilePicker({ accessToken: "token", apiKey: " ", loadRuntime })).rejects.toThrow("API key");
    expect(loadRuntime).not.toHaveBeenCalled();
  });
});

describe("createGooglePickerExecutor", () => {
  it("passes the model's reason to the UI bridge and reports handed-over files", async () => {
    const requestFilePick = vi.fn(async (): Promise<PickedDriveFile[] | null> => [
      { id: FILE_ID, name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }
    ]);
    const execute = createGooglePickerExecutor(requestFilePick);
    const outcome = await execute(GOOGLE_PICKER_TOOL.name, { reason: "I need last year's budget sheet." }, {});

    expect(requestFilePick).toHaveBeenCalledWith("I need last year's budget sheet.", undefined);
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain(FILE_ID);
    expect(outcome.content).toContain("Budget");
    expect(outcome.content).toContain("accessible to the Google tools");
  });

  it("reports a decline as an answer, not an error", async () => {
    const execute = createGooglePickerExecutor(async () => null);
    const outcome = await execute(GOOGLE_PICKER_TOOL.name, {}, {});

    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain("declined");
  });
});
