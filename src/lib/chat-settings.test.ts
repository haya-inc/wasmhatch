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
  models: { anthropic: "claude-sonnet-5-5" },
  keys: { anthropic: "sk-ant-test" },
  rememberKey: false,
  webSearch: true,
  ...overrides
});

describe("chat settings persistence", () => {
  it("upgrades saved cloud presets when restoring existing tabs or devices", () => {
    const local = new FakeStore();
    const session = new FakeStore();
    saveChatSettings(snapshot({
      models: {
        anthropic: "claude-sonnet-5",
        openai: "gpt-5.6-terra",
        openrouter: "google/gemini-3.5-flash"
      }
    }), { session, local });

    const expected = {
      anthropic: "claude-sonnet-5-5",
      openai: "gpt-6.1-terra",
      openrouter: "google/gemini-4-hydrogen"
    };
    expect(loadChatSettings({ session, local }).models).toEqual(expected);
    expect(loadChatSettings({ session: new FakeStore(), local }).models).toEqual(expected);
    // A regular save records the migrated selections for subsequent loads.
    saveChatSettings(loadChatSettings({ session, local }), { session, local });
    expect(loadChatSettings({ session, local }).models).toEqual(expected);
  });

  it.each([
    ["anthropic", "claude-opus-4-8", "claude-opus-5-5"],
    ["anthropic", "claude-haiku-4-5", "claude-haiku-5-5"],
    ["openai", "gpt-5.6-sol", "gpt-6.1-sol"],
    ["openai", "gpt-5.6-luna", "gpt-6-luna"],
    ["openrouter", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5"],
    ["openrouter", "anthropic/claude-opus-4.8", "anthropic/claude-opus-5.5"],
    ["openrouter", "openai/gpt-5.2", "openai/gpt-6.1-sol"],
    ["openrouter", "x-ai/grok-4.3", "x-ai/grok-4.7"],
    ["openrouter", "deepseek/deepseek-chat", "deepseek/deepseek-v4.1-flash-1017"]
  ])("upgrades the former %s preset %s to %s", (provider, previous, current) => {
    const session = new FakeStore();
    session.setItem("wasmhatch-chat-settings-v1", JSON.stringify({ models: { [provider]: previous } }));
    expect(loadChatSettings({ session }).models).toEqual({ [provider]: current });
  });

  it("preserves custom IDs, pinned snapshots, and installed local model tags", () => {
    const session = new FakeStore();
    const settings = snapshot({
      models: {
        anthropic: "claude-sonnet-4-20250514",
        openai: "ft:custom-model",
        openrouter: "toString",
        ollama: "llama3.2"
      }
    });
    saveChatSettings(settings, { session });
    expect(loadChatSettings({ session })).toEqual(settings);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadChatSettings({ session: new FakeStore(), local: new FakeStore() })).toEqual({
      provider: "builtin",
      models: {},
      keys: {},
      rememberKey: false,
      webSearch: true
    });
    expect(loadChatSettings({})).toEqual({ provider: "builtin", models: {}, keys: {}, rememberKey: false, webSearch: true });
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
      JSON.stringify({ provider: "mystery", models: { anthropic: 7, phantom_provider: "x" }, keys: null, rememberKey: "yes" })
    );

    expect(loadChatSettings({ session, local })).toEqual({
      provider: "builtin",
      models: {},
      keys: {},
      rememberKey: false,
      webSearch: true
    });
  });

  it("never throws when the stores are unusable", () => {
    const stores = { session: new BrokenStore(), local: new BrokenStore() };
    expect(() => saveChatSettings(snapshot(), stores)).not.toThrow();
    expect(loadChatSettings(stores)).toEqual({ provider: "builtin", models: {}, keys: {}, rememberKey: false, webSearch: true });
  });

  it("round-trips the web-search preference and defaults legacy snapshots to on", () => {
    const session = new FakeStore();
    const local = new FakeStore();
    saveChatSettings(snapshot({ webSearch: false }), { session, local });
    expect(loadChatSettings({ session, local }).webSearch).toBe(false);

    // A snapshot written before the field existed reads back as on.
    local.setItem("wasmhatch-chat-settings-v1", JSON.stringify({ provider: "anthropic", models: {}, keys: {}, rememberKey: false }));
    expect(loadChatSettings({ session: new FakeStore(), local }).webSearch).toBe(true);
  });

  it("round-trips OpenRouter, the third key type beyond the original two", () => {
    const session = new FakeStore();
    const local = new FakeStore();
    const openrouter: ChatSettingsSnapshot = {
      provider: "openrouter",
      models: { openrouter: "anthropic/claude-sonnet-5.5" },
      keys: { openrouter: "sk-or-test" },
      rememberKey: true,
      webSearch: false
    };
    saveChatSettings(openrouter, { session, local });
    expect(loadChatSettings({ session, local })).toEqual(openrouter);
  });
});
