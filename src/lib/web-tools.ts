/**
 * User-key web tools — the search fallback stage of the web plan.
 *
 * Provider-native search (Anthropic's server-side web_search tool, OpenRouter's
 * web plugin) stays the first choice; these tools exist for the providers that
 * cannot search from their own side (Chrome built-in, Ollama, OpenAI direct).
 * Both origins were CORS-probed from a real browser page (2026-07-21): Tavily
 * reflects the origin and allows the Authorization header; the Jina Reader
 * answers page fetches the same way. Both are in the audited CSP allowlist.
 *
 * The keys are credentials: tab memory only, supplied per call, never present
 * in tool results or error text.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";
import { resolveFetch } from "./google-rest";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const JINA_READER_BASE_URL = "https://r.jina.ai/";

const MAX_QUERY_LENGTH = 400;
const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 10;
/** Snippets ride into model context; bound each one. */
const SNIPPET_CHAR_LIMIT = 1_200;
/** A fetched page rides into model context; bound it hard. */
const PAGE_CHAR_LIMIT = 30_000;
const MAX_URL_LENGTH = 2_048;

export const WEB_SEARCH_FALLBACK_TOOL: AgentToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return the top results (title, URL, snippet). " +
    "Use it when current information would change the answer. " +
    "Runs on the user's Tavily key; each call spends their quota, so search deliberately, not exhaustively.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain-language search query." },
      max_results: {
        type: "number",
        description: `How many results to return (1–${MAX_RESULT_COUNT}, default ${DEFAULT_RESULT_COUNT}).`
      }
    },
    required: ["query"],
    additionalProperties: false
  }
};

export const FETCH_PAGE_TOOL: AgentToolDefinition = {
  name: "fetch_page",
  description:
    "Fetch one public web page and return its readable text (markdown). " +
    "Use it to read a specific http(s) URL in full — for example a promising search result. " +
    "Runs through the Jina Reader on the user's key; it cannot log in to sites or submit forms.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page to read." }
    },
    required: ["url"],
    additionalProperties: false
  }
};

export const WEB_TOOLS: readonly AgentToolDefinition[] = [WEB_SEARCH_FALLBACK_TOOL, FETCH_PAGE_TOOL];

export interface WebToolKeys {
  /** Tavily API key; "" while search is not connected. */
  tavily: string;
  /** Jina Reader API key; "" while page reading is not connected. */
  jina: string;
}

function fail(content: string): AgentToolOutcome {
  return { content, isError: true };
}

/** Maps an HTTP failure to a sentence a user can act on. Never echoes the key. */
function describeHttpFailure(service: "Tavily" | "the Jina Reader", status: number): string {
  if (status === 401 || status === 403) {
    return `${service} rejected the key (${status}). Reconnect with a fresh key from the provider's dashboard.`;
  }
  if (status === 429) return `${service} is rate-limiting this key. Wait a moment before trying again.`;
  if (status === 402 || status === 432) {
    return `${service} reports the key's quota is exhausted (${status}). Top up or wait for the quota to reset.`;
  }
  if (status >= 500) return `${service} is temporarily unavailable (${status}). Retry shortly.`;
  return `${service} declined the request (${status}).`;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface TavilyBody {
  answer?: unknown;
  results?: unknown;
}

function renderSearchResults(body: TavilyBody): string {
  const lines: string[] = [];
  if (typeof body.answer === "string" && body.answer.trim()) {
    lines.push(`Answer summary: ${truncate(body.answer.trim(), SNIPPET_CHAR_LIMIT).text}`);
  }
  const results = (Array.isArray(body.results) ? body.results : [])
    .flatMap((entry): Array<{ title: string; url: string; snippet: string }> => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as TavilyResult;
      if (typeof record.url !== "string" || !record.url) return [];
      return [{
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : record.url,
        url: record.url,
        snippet: typeof record.content === "string" ? truncate(record.content.trim(), SNIPPET_CHAR_LIMIT).text : ""
      }];
    });
  if (!results.length && !lines.length) {
    return "The search returned no results. Try different terms.";
  }
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`);
  });
  return lines.join("\n");
}

function requirePageUrl(args: Record<string, unknown>): URL | AgentToolOutcome {
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) return fail("fetch_page requires an absolute http(s) URL.");
  if (raw.length > MAX_URL_LENGTH) return fail(`fetch_page URLs are limited to ${MAX_URL_LENGTH.toLocaleString()} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("fetch_page requires an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("fetch_page reads only http(s) pages.");
  }
  return url;
}

/**
 * Creates the executor for WEB_TOOLS. `getKeys` is read per call so the keys
 * live only in the caller's memory and never land in outcomes.
 */
export function createWebToolExecutor(
  getKeys: () => WebToolKeys,
  options?: { fetchImpl?: typeof fetch }
): AgentToolExecutor {
  const fetchImpl = resolveFetch(options?.fetchImpl);
  return async (name, args, context): Promise<AgentToolOutcome> => {
    try {
      if (name === WEB_SEARCH_FALLBACK_TOOL.name) {
        const key = getKeys().tavily.trim();
        if (!key) {
          return fail("Web search is not connected. Ask the user to add their Tavily key in the sidebar.");
        }
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return fail("web_search requires a non-empty query.");
        if (query.length > MAX_QUERY_LENGTH) {
          return fail(`web_search queries are limited to ${MAX_QUERY_LENGTH} characters. Ask something more specific.`);
        }
        const requested = typeof args.max_results === "number" && Number.isFinite(args.max_results)
          ? Math.round(args.max_results)
          : DEFAULT_RESULT_COUNT;
        const maxResults = Math.min(MAX_RESULT_COUNT, Math.max(1, requested));
        const response = await fetchImpl(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            max_results: maxResults,
            include_answer: true
          }),
          signal: context?.signal,
          cache: "no-store",
          credentials: "omit"
        });
        if (!response.ok) return fail(describeHttpFailure("Tavily", response.status));
        let body: TavilyBody;
        try {
          body = await response.json() as TavilyBody;
        } catch {
          return fail("Tavily answered with something other than JSON. Retry shortly.");
        }
        return { content: renderSearchResults(body) };
      }

      if (name === FETCH_PAGE_TOOL.name) {
        const key = getKeys().jina.trim();
        if (!key) {
          return fail("Page reading is not connected. Ask the user to add their Jina key in the sidebar.");
        }
        const url = requirePageUrl(args);
        if (!(url instanceof URL)) return url;
        const response = await fetchImpl(`${JINA_READER_BASE_URL}${url.toString()}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${key}`,
            accept: "text/plain"
          },
          signal: context?.signal,
          cache: "no-store",
          credentials: "omit"
        });
        if (!response.ok) return fail(describeHttpFailure("the Jina Reader", response.status));
        const text = (await response.text()).trim();
        if (!text) return fail("The page came back empty. It may need a login or block automated readers.");
        const bounded = truncate(text, PAGE_CHAR_LIMIT);
        return {
          content: bounded.truncated
            ? `${bounded.text}\n\n[Truncated at ${PAGE_CHAR_LIMIT.toLocaleString()} characters — the page continues.]`
            : bounded.text
        };
      }

      return fail(`Unknown web tool: ${name}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Network-layer failures never contain the key; keep the cause, bounded.
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return fail(`The web request failed before completion (${cause.slice(0, 160)}). Check the connection and retry.`);
    }
  };
}
