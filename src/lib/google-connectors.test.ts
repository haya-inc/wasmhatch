import { describe, expect, it, vi } from "vitest";
import { GOOGLE_CONNECTOR_TOOLS, createGoogleConnectorExecutor } from "./google-connectors";

const FAKE_TOKEN = "ya29.FAKE-TEST-TOKEN";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function recordingExecutor(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected extra request in test.");
    return next;
  });
  const getToken = vi.fn(async () => FAKE_TOKEN);
  const execute = createGoogleConnectorExecutor(getToken, { fetchImpl: fetchImpl as unknown as typeof fetch });
  return { calls, execute, getToken };
}

function expectNoTokenLeak(value: string) {
  expect(value).not.toContain(FAKE_TOKEN);
}

describe("GOOGLE_CONNECTOR_TOOLS", () => {
  it("exposes the six drive.file-compatible tools", () => {
    expect(GOOGLE_CONNECTOR_TOOLS.map((tool) => tool.name)).toEqual([
      "create_google_doc",
      "create_google_sheet",
      "create_google_slides",
      "read_google_sheet_values",
      "update_google_sheet_values",
      "append_google_doc_text"
    ]);
  });
});

describe("createGoogleConnectorExecutor", () => {
  it("creates a Google Doc with initial text via Drive create + Docs batchUpdate", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ id: "doc-id-1234567890", name: "Notes", webViewLink: "https://docs.google.com/d/x" }),
      jsonResponse({})
    ]);
    const outcome = await execute("create_google_doc", { title: "Notes", text: "Hello" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(JSON.parse(outcome.content)).toEqual({
      id: "doc-id-1234567890",
      name: "Notes",
      webViewLink: "https://docs.google.com/d/x"
    });
    expect(calls[0].url).toBe("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "Notes",
      mimeType: "application/vnd.google-apps.document"
    });
    expect(calls[1].url).toBe("https://docs.googleapis.com/v1/documents/doc-id-1234567890:batchUpdate");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      requests: [{ insertText: { location: { index: 1 }, text: "Hello" } }]
    });
  });

  it("creates a Sheet and appends initial rows", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ id: "sheet-id-1234567890", name: "Data", webViewLink: null }),
      jsonResponse({})
    ]);
    const outcome = await execute("create_google_sheet", { title: "Data", rows: [["a", "b"], ["1", "2"]] }, {});
    expect(outcome.isError).toBeFalsy();
    expect(calls[1].url).toContain("/v4/spreadsheets/sheet-id-1234567890/values/A1:append?valueInputOption=RAW");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ values: [["a", "b"], ["1", "2"]] });
  });

  it("creates Slides with the presentation mime type", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ id: "slides-id-1234567890", name: "Deck", webViewLink: "https://docs.google.com/p/x" })
    ]);
    const outcome = await execute("create_google_slides", { title: "Deck" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(JSON.parse(String(calls[0].init.body)).mimeType).toBe("application/vnd.google-apps.presentation");
  });

  it("reads sheet values with a default range", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ range: "Sheet1!A1:Z1000", values: [["x"]] })
    ]);
    const outcome = await execute("read_google_sheet_values", { spreadsheetId: "sheet-id-1234567890" }, {});
    expect(JSON.parse(outcome.content)).toEqual({ range: "Sheet1!A1:Z1000", values: [["x"]] });
    expect(calls[0].url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet-id-1234567890/values/${encodeURIComponent("A1:Z1000")}`
    );
  });

  it("updates sheet values and reports the cell count", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({ updatedCells: 4 })]);
    const outcome = await execute(
      "update_google_sheet_values",
      { spreadsheetId: "sheet-id-1234567890", range: "A1:B2", values: [["a", "b"], ["c", "d"]] },
      {}
    );
    expect(JSON.parse(outcome.content)).toEqual({ updatedCells: 4 });
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toContain("valueInputOption=RAW");
  });

  it("appends doc text just before the trailing newline", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } }),
      jsonResponse({})
    ]);
    const outcome = await execute("append_google_doc_text", { documentId: "doc-id-1234567890", text: "More" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      requests: [{ insertText: { location: { index: 41 }, text: "More" } }]
    });
  });

  it("binds the default fetch so the browser never sees an illegal `this`", async () => {
    const original = globalThis.fetch;
    // Simulate Chrome's window.fetch, which rejects any `this` other than the global.
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse({ id: "slides-id-1234567890", name: "Deck", webViewLink: null }));
    } as typeof fetch;
    try {
      const execute = createGoogleConnectorExecutor(async () => FAKE_TOKEN);
      const outcome = await execute("create_google_slides", { title: "Deck" }, {});
      expect(outcome.isError).toBeFalsy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends the token only in the Authorization header and never leaks it", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ id: "doc-id-1234567890", name: "n", webViewLink: null })
    ]);
    const outcome = await execute("create_google_doc", { title: "n" }, {});
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls[0].url).not.toContain(FAKE_TOKEN);
    expect(String(calls[0].init.body)).not.toContain(FAKE_TOKEN);
    expectNoTokenLeak(outcome.content);
  });

  it("maps HTTP failures to plain-language errors without the token", async () => {
    const cases: Array<[number, RegExp]> = [
      [401, /Reconnect Google/],
      [403, /denied this request/],
      [404, /drive\.file only covers files WasmHatch created/],
      [429, /rate limit/],
      [503, /temporarily unavailable/]
    ];
    for (const [status, pattern] of cases) {
      const { execute } = recordingExecutor([jsonResponse({ error: { message: "detail" } }, status)]);
      const outcome = await execute("create_google_slides", { title: "t" }, {});
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(pattern);
      expectNoTokenLeak(outcome.content);
    }
  });

  it("rejects invalid arguments without making requests", async () => {
    const { calls, execute } = recordingExecutor([]);
    expect((await execute("create_google_doc", { title: "" }, {})).isError).toBe(true);
    expect((await execute("create_google_doc", { title: "x".repeat(513) }, {})).isError).toBe(true);
    expect((await execute("read_google_sheet_values", { spreadsheetId: "short" }, {})).isError).toBe(true);
    expect((await execute("update_google_sheet_values", { spreadsheetId: "sheet-id-1234567890", range: "A1", values: [] }, {})).isError).toBe(true);
    expect((await execute("append_google_doc_text", { documentId: "doc-id-1234567890", text: "" }, {})).isError).toBe(true);
    expect((await execute("mystery_tool", {}, {})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized value payloads", async () => {
    const { calls, execute } = recordingExecutor([]);
    const wide = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => "x"));
    const outcome = await execute(
      "update_google_sheet_values",
      { spreadsheetId: "sheet-id-1234567890", range: "A1", values: wide },
      {}
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("10,000-cell");
    expect(calls).toHaveLength(0);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const { execute } = recordingExecutor([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      execute("create_google_slides", { title: "t" }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
