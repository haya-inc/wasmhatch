import { describe, expect, it } from "vitest";
import {
  loadChatSettings,
  saveChatSettings,
  type ChatSettingsSnapshot,
  type KeyValueStore
} from "./chat-settings";

class FakeStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  dump(): string {
    return [...this.values.values()].join("\n");
  }
}

class BrokenStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error("storage blocked");
  }

  setItem(): void {
    throw new Error("storage full");
  }
}

const snapshot = (overrides: Partial<ChatSettingsSnapshot> = {}): ChatSettingsSnapshot => ({
  provider: "anthropic",
  models: { anthropic: "claude-sonnet-5" },
  keys: { anthropic: "sk-ant-test" },
  rememberKey: false,
  ...overrides
});

describe("chat settings persistence", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadChatSettings({ session: new FakeStore(), local: new FakeStore() })).toEqual({
      provider: "builtin",
      models: {},
      keys: {},
      rememberKey: false
    });
    expect(loadChatSettings({})).toEqual({ provider: "builtin", models: {}, keys: {}, rememberKey: false });
  });

  it("keeps the key for the tab but out of the device store unless remembered", () => {
    const session = new FakeStore();
    const local = new FakeStore();
    saveChatSettings(snapshot(), { session, local });

    expect(session.dump()).toContain("sk-ant-test");
    expect(local.dump()).not.toContain("sk-ant-test");
    expect(loadChatSettings({ session, local })).toEqual(snapshot());
    // A fresh tab (empty session store) restores preferences but never the key.
    expect(loadChatSettings({ session: new FakeStore(), local })).toEqual(snapshot({ keys: {} }));
  });

  it("restores the key across tabs once remembering is on", () => {
    const local = new FakeStore();
    saveChatSettings(snapshot({ rememberKey: true }), { session: new FakeStore(), local });

    expect(local.dump()).toContain("sk-ant-test");
    expect(loadChatSettings({ session: new FakeStore(), local })).toEqual(snapshot({ rememberKey: true }));
  });

  it("prefers the tab snapshot over the device one, but the device decides remembering", () => {
    const session = new FakeStore();
    const local = new FakeStore();
    saveChatSettings(snapshot({ provider: "openai", keys: { openai: "sk-tab" }, models: {} }), { session, local });
    saveChatSettings(snapshot({ rememberKey: true }), { session: new FakeStore(), local });

    const loaded = loadChatSettings({ session, local });
    expect(loaded.provider).toBe("openai");
    expect(loaded.keys).toEqual({ openai: "sk-tab" });
    expect(loaded.rememberKey).toBe(true);
  });

  it("ignores corrupt or foreign snapshots", () => {
    const session = new FakeStore();
    const local = new FakeStore();
    session.setItem("wasmhatch-chat-settings-v1", "{not json");
    local.setItem(
      "wasmhatch-chat-settings-v1",
      JSON.stringify({ provider: "mystery", models: { anthropic: 7, gemini: "x" }, keys: null, rememberKey: "yes" })
    );

    expect(loadChatSettings({ session, local })).toEqual({
      provider: "builtin",
      models: {},
      keys: {},
      rememberKey: false
    });
  });

  it("never throws when the stores are unusable", () => {
    const stores = { session: new BrokenStore(), local: new BrokenStore() };
    expect(() => saveChatSettings(snapshot(), stores)).not.toThrow();
    expect(loadChatSettings(stores)).toEqual({ provider: "builtin", models: {}, keys: {}, rememberKey: false });
  });
});
