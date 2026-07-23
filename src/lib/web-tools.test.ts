import { describe, expect, it, vi } from "vitest";
import {
  createWebToolExecutor,
  FETCH_PAGE_TOOL,
  JINA_READER_BASE_URL,
  TAVILY_SEARCH_URL,
  WEB_SEARCH_FALLBACK_TOOL,
  WEB_TOOLS
} from "./web-tools";

const KEYS = { tavily: "tvly-test-key", jina: "jina_test_key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeExecutor(fetchImpl: typeof fetch, keys = KEYS) {
  return createWebToolExecutor(() => keys, { fetchImpl });
}

describe("createWebToolExecutor", () => {
  it("exposes the two web tools", () => {
    expect(WEB_TOOLS.map((tool) => tool.name)).toEqual(["web_search", "fetch_page"]);
  });

  it("searches through Tavily with the key in the Authorization header only", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(TAVILY_SEARCH_URL);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer tvly-test-key");
      expect(init?.credentials).toBe("omit");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.query).toBe("wasm agents");
      expect(body.api_key).toBeUndefined();
      return jsonResponse({
        answer: "Wasm agents run in the browser.",
        results: [
          { title: "WasmHatch", url: "https://wasmhatch.com", content: "A browser agent." },
          { url: "https://example.com/no-title", content: "Untitled result." }
        ]
      });
    });
    const execute = makeExecutor(fetchImpl as typeof fetch);
    const outcome = await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "wasm agents" }, {});
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content).toContain("Answer summary: Wasm agents run in the browser.");
    expect(outcome.content).toContain("1. WasmHatch\n   https://wasmhatch.com");
    expect(outcome.content).toContain("2. https://example.com/no-title");
    expect(outcome.content).not.toContain("tvly-test-key");
  });

  it("clamps max_results into the allowed range", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_results).toBe(10);
      return jsonResponse({ results: [] });
    });
    const execute = makeExecutor(fetchImpl as typeof fetch);
    await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "q", max_results: 99 }, {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an empty search plainly", async () => {
    const execute = makeExecutor((async () => jsonResponse({ results: [] })) as typeof fetch);
    const outcome = await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "nothing" }, {});
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content).toContain("no results");
  });

  it("fails closed without a Tavily key and never calls the network", async () => {
    const fetchImpl = vi.fn();
    const execute = makeExecutor(fetchImpl as unknown as typeof fetch, { tavily: "  ", jina: "jina_x" });
    const outcome = await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "q" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty query and an oversize query", async () => {
    const fetchImpl = vi.fn();
    const execute = makeExecutor(fetchImpl as unknown as typeof fetch);
    expect((await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "   " }, {})).isError).toBe(true);
    expect((await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "q".repeat(401) }, {})).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps Tavily auth and rate-limit failures to actionable sentences without the key", async () => {
    for (const [status, fragment] of [[401, "rejected the key"], [429, "rate-limiting"], [500, "temporarily unavailable"]] as const) {
      const execute = makeExecutor((async () => new Response("nope", { status })) as typeof fetch);
      const outcome = await execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "q" }, {});
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toContain(fragment);
      expect(outcome.content).not.toContain("tvly-test-key");
    }
  });

  it("fetches a page through the Jina Reader and returns its text", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${JINA_READER_BASE_URL}https://example.com/article`);
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer jina_test_key");
      expect(init?.method).toBe("GET");
      return new Response("# Title\n\nBody text.");
    });
    const execute = makeExecutor(fetchImpl as typeof fetch);
    const outcome = await execute(FETCH_PAGE_TOOL.name, { url: "https://example.com/article" }, {});
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content).toBe("# Title\n\nBody text.");
  });

  it("truncates oversize pages with a note", async () => {
    const execute = makeExecutor((async () => new Response("x".repeat(40_000))) as typeof fetch);
    const outcome = await execute(FETCH_PAGE_TOOL.name, { url: "https://example.com" }, {});
    expect(outcome.content.length).toBeLessThan(31_000);
    expect(outcome.content).toContain("Truncated at 30,000 characters");
  });

  it("rejects non-http URLs, relative URLs, and oversize URLs without a network call", async () => {
    const fetchImpl = vi.fn();
    const execute = makeExecutor(fetchImpl as unknown as typeof fetch);
    for (const url of ["ftp://example.com", "javascript:alert(1)", "/relative", `https://example.com/${"a".repeat(2_100)}`]) {
      const outcome = await execute(FETCH_PAGE_TOOL.name, { url }, {});
      expect(outcome.isError).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed without a Jina key", async () => {
    const fetchImpl = vi.fn();
    const execute = makeExecutor(fetchImpl as unknown as typeof fetch, { tavily: "tvly-x", jina: "" });
    const outcome = await execute(FETCH_PAGE_TOOL.name, { url: "https://example.com" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an empty page body as an error", async () => {
    const execute = makeExecutor((async () => new Response("   ")) as typeof fetch);
    const outcome = await execute(FETCH_PAGE_TOOL.name, { url: "https://example.com" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("empty");
  });

  it("rethrows aborts and keeps other network failures key-free", async () => {
    const abortingFetch = (async () => { throw new DOMException("Aborted", "AbortError"); }) as typeof fetch;
    const execute = makeExecutor(abortingFetch);
    await expect(execute(WEB_SEARCH_FALLBACK_TOOL.name, { query: "q" }, {})).rejects.toThrow("Aborted");

    const failingFetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const failing = makeExecutor(failingFetch);
    const outcome = await failing(FETCH_PAGE_TOOL.name, { url: "https://example.com" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("TypeError: Failed to fetch");
    expect(outcome.content).not.toContain("jina_test_key");
  });

  it("answers unknown tool names with an error outcome", async () => {
    const execute = makeExecutor((async () => jsonResponse({})) as typeof fetch);
    const outcome = await execute("unknown_tool", {}, {});
    expect(outcome.isError).toBe(true);
  });
});
