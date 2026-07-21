import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./chat-settings";
import {
  CHAT_TRANSCRIPT_MAX_BYTES,
  clearChatTranscript,
  loadChatTranscript,
  saveChatTranscript
} from "./chat-transcript-store";

class FakeStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
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

interface Item {
  id: number;
  kind: string;
  text: string;
}

interface Message {
  role: string;
  parts: Array<{ type: string; text: string }>;
}

function turn(index: number, padding = 8): { items: Item[]; messages: Message[] } {
  const filler = "x".repeat(padding);
  return {
    items: [
      { id: index * 2 + 1, kind: "user", text: `question ${index} ${filler}` },
      { id: index * 2 + 2, kind: "assistant", text: `answer ${index} ${filler}` }
    ],
    messages: [
      { role: "user", parts: [{ type: "text", text: `question ${index} ${filler}` }] },
      { role: "assistant", parts: [{ type: "text", text: `answer ${index} ${filler}` }] }
    ]
  };
}

function thread(turns: number, padding = 8) {
  const items: Item[] = [];
  const messages: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    const built = turn(index, padding);
    items.push(...built.items);
    messages.push(...built.messages);
  }
  return { items, messages };
}

describe("chat transcript store", () => {
  it("round-trips a thread for the same provider", () => {
    const store = new FakeStore();
    const { items, messages } = thread(2);
    saveChatTranscript({ provider: "anthropic", items, messages, nextId: 9 }, store);
    const loaded = loadChatTranscript<Item, Message>("anthropic", store);
    expect(loaded).not.toBeNull();
    expect(loaded?.items).toEqual(items);
    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.nextId).toBe(9);
  });

  it("does not restore a thread stored for another provider", () => {
    const store = new FakeStore();
    const { items, messages } = thread(1);
    saveChatTranscript({ provider: "anthropic", items, messages, nextId: 3 }, store);
    expect(loadChatTranscript("openai", store)).toBeNull();
  });

  it("returns null for corrupt, empty, or foreign blobs", () => {
    const store = new FakeStore();
    store.setItem("wasmhatch-chat-transcript-v1", "{not json");
    expect(loadChatTranscript("anthropic", store)).toBeNull();
    store.setItem("wasmhatch-chat-transcript-v1", JSON.stringify({ schemaVersion: 2 }));
    expect(loadChatTranscript("anthropic", store)).toBeNull();
    saveChatTranscript({ provider: "anthropic", items: [], messages: [], nextId: 1 }, store);
    expect(loadChatTranscript("anthropic", store)).toBeNull();
  });

  it("never hands back an id the thread already used", () => {
    const store = new FakeStore();
    const { items, messages } = thread(2);
    saveChatTranscript({ provider: "anthropic", items, messages, nextId: 2 }, store);
    const loaded = loadChatTranscript<Item, Message>("anthropic", store);
    expect(loaded?.nextId).toBe(5);
  });

  it("drops the oldest whole turns when the thread is over budget", () => {
    const store = new FakeStore();
    const { items, messages } = thread(4, 64);
    const full = JSON.stringify({ schemaVersion: 1, provider: "anthropic", nextId: 99, items, messages });
    saveChatTranscript(
      { provider: "anthropic", items, messages, nextId: 99 },
      store,
      new TextEncoder().encode(full).byteLength - 1
    );
    const loaded = loadChatTranscript<Item, Message>("anthropic", store);
    expect(loaded).not.toBeNull();
    expect(loaded!.items.length).toBeLessThan(items.length);
    expect(loaded!.items[0]?.kind).toBe("user");
    expect(loaded!.messages[0]?.role).toBe("user");
    expect(loaded!.items.length / 2).toBe(loaded!.messages.length / 2);
  });

  it("stores nothing when even the newest turn exceeds the budget", () => {
    const store = new FakeStore();
    const { items, messages } = thread(1, 64);
    saveChatTranscript({ provider: "anthropic", items, messages, nextId: 3 }, store, 32);
    expect(loadChatTranscript("anthropic", store)).toBeNull();
  });

  it("trims by items alone when there are no wire messages", () => {
    const store = new FakeStore();
    const { items } = thread(4, 64);
    const full = JSON.stringify({ schemaVersion: 1, provider: "builtin", nextId: 99, items, messages: [] });
    saveChatTranscript(
      { provider: "builtin", items, messages: [], nextId: 99 },
      store,
      new TextEncoder().encode(full).byteLength - 1
    );
    const loaded = loadChatTranscript<Item, Message>("builtin", store);
    expect(loaded).not.toBeNull();
    expect(loaded!.items.length).toBeLessThan(items.length);
    expect(loaded!.items[0]?.kind).toBe("user");
  });

  it("survives blocked storage without throwing", () => {
    const store = new BrokenStore();
    const { items, messages } = thread(1);
    expect(() => saveChatTranscript({ provider: "anthropic", items, messages, nextId: 3 }, store)).not.toThrow();
    expect(loadChatTranscript("anthropic", store)).toBeNull();
    expect(() => clearChatTranscript(store)).not.toThrow();
  });

  it("clears the stored thread", () => {
    const store = new FakeStore();
    const { items, messages } = thread(1);
    saveChatTranscript({ provider: "anthropic", items, messages, nextId: 3 }, store);
    clearChatTranscript(store);
    expect(loadChatTranscript("anthropic", store)).toBeNull();
  });

  it("keeps the default budget generous enough for real threads", () => {
    expect(CHAT_TRANSCRIPT_MAX_BYTES).toBeGreaterThanOrEqual(500_000);
  });
});
