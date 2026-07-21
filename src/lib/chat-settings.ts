import { CLOUD_PROVIDER_IDS, isCloudProviderId, type ChatProviderId, type CloudProviderId } from "./chat-providers";

export type ChatProviderKind = ChatProviderId;
export type CloudChatProvider = CloudProviderId;

export interface ChatSettingsSnapshot {
  provider: ChatProviderKind;
  models: Partial<Record<CloudChatProvider, string>>;
  keys: Partial<Record<CloudChatProvider, string>>;
  rememberKey: boolean;
  /** Provider-native web search, where the provider supports it. On by default for incumbent parity. */
  webSearch: boolean;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChatSettingsStores {
  session?: KeyValueStore | null;
  local?: KeyValueStore | null;
}

const STORAGE_KEY = "wasmhatch-chat-settings-v1";
const CLOUD_PROVIDERS: readonly CloudChatProvider[] = CLOUD_PROVIDER_IDS;

function defaultStores(): ChatSettingsStores {
  try {
    return {
      session: typeof sessionStorage === "undefined" ? null : sessionStorage,
      local: typeof localStorage === "undefined" ? null : localStorage
    };
  } catch {
    return {};
  }
}

function read(store: KeyValueStore | null | undefined): string | null {
  try {
    return store?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(store: KeyValueStore | null | undefined, value: string): void {
  try {
    store?.setItem(STORAGE_KEY, value);
  } catch {
    // Settings persistence is best-effort; a full or blocked store must not break chat.
  }
}

function pickStringMap(value: unknown): Partial<Record<CloudChatProvider, string>> {
  const map: Partial<Record<CloudChatProvider, string>> = {};
  if (value && typeof value === "object") {
    for (const provider of CLOUD_PROVIDERS) {
      const entry = (value as Record<string, unknown>)[provider];
      if (typeof entry === "string" && entry) map[provider] = entry;
    }
  }
  return map;
}

function parseSnapshot(raw: string | null): Partial<ChatSettingsSnapshot> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const snapshot: Partial<ChatSettingsSnapshot> = {
      models: pickStringMap(record.models),
      keys: pickStringMap(record.keys)
    };
    if (record.provider === "builtin" || isCloudProviderId(record.provider)) {
      snapshot.provider = record.provider;
    }
    if (typeof record.rememberKey === "boolean") snapshot.rememberKey = record.rememberKey;
    if (typeof record.webSearch === "boolean") snapshot.webSearch = record.webSearch;
    return snapshot;
  } catch {
    return null;
  }
}

export function loadChatSettings(stores: ChatSettingsStores = defaultStores()): ChatSettingsSnapshot {
  const local = parseSnapshot(read(stores.local));
  const session = parseSnapshot(read(stores.session));
  const base = session ?? local ?? {};
  return {
    provider: base.provider ?? "builtin",
    models: base.models ?? {},
    keys: base.keys ?? {},
    // Remembering is a device-level choice, so the persistent store decides it.
    rememberKey: local?.rememberKey ?? base.rememberKey ?? false,
    webSearch: base.webSearch ?? true
  };
}

export function saveChatSettings(snapshot: ChatSettingsSnapshot, stores: ChatSettingsStores = defaultStores()): void {
  write(stores.session, JSON.stringify(snapshot));
  const persisted = snapshot.rememberKey ? snapshot : { ...snapshot, keys: {} };
  write(stores.local, JSON.stringify(persisted));
}
