/**
 * Persists the chat thread across reloads.
 *
 * One thread lives under one localStorage key: the visible transcript items,
 * the provider wire messages, and the next item id. The stored blob is
 * byte-capped; when it grows past the cap, whole oldest turns are dropped
 * first. A turn boundary is a user message, so provider history is never cut
 * between a tool call and its result. A thread whose newest turn alone
 * exceeds the cap is not persisted at all — failing open beats storing a
 * torn conversation. Reads validate structurally and return null on any
 * anomaly; a corrupt blob must never break page boot.
 */

import type { KeyValueStore } from "./chat-settings";
import type { AsyncTextStore } from "./opfs-kv";

const STORAGE_KEY = "wasmhatch-chat-transcript-v1";

const THREAD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function threadKey(threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error(`Invalid thread id: ${threadId}`);
  return `transcript-${threadId}`;
}

export const CHAT_TRANSCRIPT_MAX_BYTES = 1_000_000;

interface TranscriptItemShape {
  id: number;
  kind: string;
}

interface TranscriptMessageShape {
  role: string;
}

export interface ChatTranscriptSnapshot<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape> {
  provider: string;
  items: readonly TItem[];
  messages: readonly TMessage[];
  nextId: number;
}

function defaultStore(): KeyValueStore | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drops the oldest complete turn from both views of the thread. Returns null
 * when fewer than two turns remain on either side — the caller must then give
 * up rather than cut inside a turn.
 */
function dropOldestTurn<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  items: readonly TItem[],
  messages: readonly TMessage[]
): { items: readonly TItem[]; messages: readonly TMessage[] } | null {
  const itemBoundary = items.findIndex((item, index) => index > 0 && item.kind === "user");
  const firstUserItem = items.findIndex((item) => item.kind === "user");
  const messageBoundary = messages.findIndex((message, index) => index > 0 && message.role === "user");
  if (messages.length === 0) {
    // Nothing on the wire side (e.g. the on-device provider): trim by items alone.
    if (itemBoundary <= 0 || firstUserItem < 0) return null;
    return { items: items.slice(itemBoundary), messages };
  }
  if (itemBoundary <= 0 || messageBoundary <= 0) return null;
  return { items: items.slice(itemBoundary), messages: messages.slice(messageBoundary) };
}

/**
 * Serializes a snapshot within the byte budget, dropping whole oldest turns
 * first. Returns null when even the newest turn alone exceeds the budget —
 * the caller should then clear the stored entry rather than persist a torn
 * conversation.
 */
export function serializeTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  snapshot: ChatTranscriptSnapshot<TItem, TMessage>,
  maxBytes: number = CHAT_TRANSCRIPT_MAX_BYTES
): string | null {
  let items = snapshot.items;
  let messages = snapshot.messages;
  let serialized = JSON.stringify({ schemaVersion: 1, provider: snapshot.provider, nextId: snapshot.nextId, items, messages });
  while (encoder.encode(serialized).byteLength > maxBytes) {
    const trimmed = dropOldestTurn(items, messages);
    if (!trimmed) return null;
    items = trimmed.items;
    messages = trimmed.messages;
    serialized = JSON.stringify({ schemaVersion: 1, provider: snapshot.provider, nextId: snapshot.nextId, items, messages });
  }
  return serialized;
}

export function saveChatTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  snapshot: ChatTranscriptSnapshot<TItem, TMessage>,
  store: KeyValueStore | null = defaultStore(),
  maxBytes: number = CHAT_TRANSCRIPT_MAX_BYTES
): void {
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, serializeTranscript(snapshot, maxBytes) ?? "");
  } catch {
    // Quota pressure or a blocked store must never surface as a page error.
    try {
      store.setItem(STORAGE_KEY, "");
    } catch {
      /* the thread simply won't survive a reload */
    }
  }
}

/** Validates a stored blob structurally; null on any anomaly or provider mismatch. */
export function parseTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  raw: string | null,
  provider: string
): { items: TItem[]; messages: TMessage[]; nextId: number } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  // A different provider means a different wire format: that thread is not restorable here.
  if (parsed.provider !== provider) return null;
  const { items, messages } = parsed;
  if (!Array.isArray(items) || !Array.isArray(messages)) return null;
  if (!items.every((item) => isRecord(item) && typeof item.id === "number" && typeof item.kind === "string")) return null;
  if (!messages.every((message) => isRecord(message) && typeof message.role === "string")) return null;
  if (items.length === 0 && messages.length === 0) return null;
  const storedNextId = typeof parsed.nextId === "number" && Number.isSafeInteger(parsed.nextId) ? parsed.nextId : 1;
  const maxItemId = items.reduce((max, item) => Math.max(max, (item as TranscriptItemShape).id), 0);
  return {
    items: items as TItem[],
    messages: messages as TMessage[],
    nextId: Math.max(1, storedNextId, maxItemId + 1)
  };
}

export function loadChatTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  provider: string,
  store: KeyValueStore | null = defaultStore()
): { items: TItem[]; messages: TMessage[]; nextId: number } | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  return parseTranscript(raw, provider);
}

export function clearChatTranscript(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(STORAGE_KEY, "");
  } catch {
    /* nothing to clear or storage is blocked — both are fine */
  }
}

/**
 * Per-thread persistence over the async meta store (OPFS). Same trim
 * semantics as the legacy single-thread localStorage path; several
 * hatchlings' transcripts must not compete for localStorage's tiny budget.
 */
export async function saveThreadTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  threadId: string,
  snapshot: ChatTranscriptSnapshot<TItem, TMessage>,
  store: AsyncTextStore,
  maxBytes: number = CHAT_TRANSCRIPT_MAX_BYTES
): Promise<void> {
  const key = threadKey(threadId);
  try {
    const serialized = serializeTranscript(snapshot, maxBytes);
    if (serialized === null) await store.remove(key);
    else await store.write(key, serialized);
  } catch {
    // Quota pressure or a blocked store must never surface as a page error.
    try {
      await store.remove(key);
    } catch {
      /* the thread simply won't survive a reload */
    }
  }
}

export async function loadThreadTranscript<TItem extends TranscriptItemShape, TMessage extends TranscriptMessageShape>(
  threadId: string,
  provider: string,
  store: AsyncTextStore
): Promise<{ items: TItem[]; messages: TMessage[]; nextId: number } | null> {
  try {
    return parseTranscript<TItem, TMessage>(await store.read(threadKey(threadId)), provider);
  } catch {
    return null;
  }
}

export async function clearThreadTranscript(threadId: string, store: AsyncTextStore): Promise<void> {
  try {
    await store.remove(threadKey(threadId));
  } catch {
    /* nothing to clear or storage is blocked — both are fine */
  }
}
