/**
 * Cloud chat provider registry.
 *
 * Deliberately small: the picker offers three key types — Anthropic and OpenAI
 * direct, plus OpenRouter as the one hub that fans out to every other model
 * (Gemini, Grok, DeepSeek, Llama, …) behind a single key — plus keyless Ollama
 * for local models. That keeps the UI to one key field and one short dropdown
 * instead of a provider zoo.
 *
 * Every provider speaks the Anthropic Messages API, the OpenAI Responses API
 * (OpenAI direct, where its reasoning models keep function tools available),
 * or the OpenAI-compatible Chat Completions API, and every origin was
 * CORS-probed to confirm a static browser page can call it directly. `connectSrc` is the single
 * source of truth for the CSP allowlist (see vite.config.ts and
 * scripts/check-built-security.mjs) — a provider is unreachable unless its origin
 * is in that audited list. Ollama's origin is plain http on loopback, which the
 * build check allows only for localhost/127.0.0.1.
 */

export type CloudProviderId = "anthropic" | "openai" | "openrouter" | "ollama";

export type ChatProviderId = "builtin" | CloudProviderId;

export interface ModelChoice {
  value: string;
  label: string;
}

export interface CloudProviderDef {
  id: CloudProviderId;
  /** Dropdown label, e.g. "Claude (your API key)". */
  label: string;
  /** Which agent-core adapter drives this provider. */
  adapter: "anthropic" | "openai-responses" | "openai-compatible";
  /** Base URL for the openai-* adapters; unused by the anthropic adapter. */
  baseUrl: string;
  /** Chat Completions param name; used by the openai-compatible adapter only. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** Exact origin added to the CSP connect-src allowlist. Never a wildcard. */
  connectSrc: string;
  /** Human host shown in the "your key goes only to X" hint. */
  host: string;
  /** API-key input placeholder. */
  keyPlaceholder: string;
  /** True for a local, keyless server (Ollama): no key field, no Authorization header. */
  keyless?: boolean;
  /**
   * How this provider's own API runs web search, when it can: Anthropic's
   * server-side web_search tool or OpenRouter's web plugin. Searches execute on
   * the provider's side and are billed by the provider alongside tokens — no
   * extra key, no new CSP origin. Absent where the endpoint cannot search
   * (Ollama, Chrome built-in) or where it is not wired up yet (the Responses
   * API's web_search for OpenAI direct).
   */
  webSearch?: "server-tool" | "plugin";
  models: ModelChoice[];
  defaultModel: string;
}

export const CLOUD_PROVIDERS: readonly CloudProviderDef[] = [
  {
    id: "anthropic",
    label: "Claude (your API key)",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    maxTokensParam: "max_tokens",
    connectSrc: "https://api.anthropic.com",
    host: "api.anthropic.com",
    keyPlaceholder: "sk-ant-…",
    webSearch: "server-tool",
    models: [
      { value: "claude-sonnet-5", label: "Claude Sonnet 5 — fast and capable (recommended)" },
      { value: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest, lowest cost" }
    ],
    defaultModel: "claude-sonnet-5"
  },
  {
    id: "openai",
    label: "OpenAI (your API key)",
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    maxTokensParam: "max_completion_tokens",
    connectSrc: "https://api.openai.com",
    host: "api.openai.com",
    keyPlaceholder: "sk-…",
    models: [
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra — fast and capable (recommended)" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol — most capable" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna — fastest, lowest cost" }
    ],
    defaultModel: "gpt-5.6-terra"
  },
  {
    id: "openrouter",
    label: "OpenRouter — one key, every model",
    adapter: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    maxTokensParam: "max_tokens",
    connectSrc: "https://openrouter.ai",
    host: "openrouter.ai",
    keyPlaceholder: "sk-or-…",
    webSearch: "plugin",
    models: [
      { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
      { value: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
      { value: "openai/gpt-5.2", label: "GPT-5.2" },
      { value: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "x-ai/grok-4.3", label: "Grok 4.3" },
      { value: "deepseek/deepseek-chat", label: "DeepSeek V3" }
    ],
    defaultModel: "anthropic/claude-sonnet-5"
  },
  {
    id: "ollama",
    label: "Ollama — local models, no key",
    adapter: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    maxTokensParam: "max_tokens",
    connectSrc: "http://localhost:11434",
    host: "localhost:11434",
    keyPlaceholder: "",
    keyless: true,
    models: [
      { value: "llama3.2", label: "Llama 3.2 (local)" },
      { value: "qwen2.5", label: "Qwen 2.5 (local)" }
    ],
    defaultModel: "llama3.2"
  }
];

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = CLOUD_PROVIDERS.map((provider) => provider.id);

const BY_ID = new Map<CloudProviderId, CloudProviderDef>(CLOUD_PROVIDERS.map((provider) => [provider.id, provider]));

export function getCloudProvider(id: CloudProviderId): CloudProviderDef {
  const provider = BY_ID.get(id);
  if (!provider) throw new Error(`Unknown cloud provider: ${id}`);
  return provider;
}

export function isCloudProviderId(value: unknown): value is CloudProviderId {
  return typeof value === "string" && BY_ID.has(value as CloudProviderId);
}

/** Origins the app must be allowed to reach, for the CSP connect-src allowlist. */
export const PROVIDER_CONNECT_SRCS: readonly string[] = CLOUD_PROVIDERS.map((provider) => provider.connectSrc);
