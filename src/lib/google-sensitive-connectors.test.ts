import { describe, expect, it, vi } from "vitest";
import { GOOGLE_SENSITIVE_TOOLS, createGoogleSensitiveExecutor } from "./google-sensitive-connectors";

const FAKE_TOKEN = "ya29.FAKE-TEST-TOKEN";
const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
const DOC_URL = `https://docs.google.com/document/d/${SHEET_ID}/edit`;
const DECK_URL = `https://docs.google.com/presentation/d/${SHEET_ID}/edit`;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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
  // Deterministic slide object IDs: id1 (slide), id2 (title), id3 (body).
  let counter = 0;
  const idFactory = () => `id${(counter += 1)}`;
  const execute = createGoogleSensitiveExecutor(getToken, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    idFactory
  });
  return { calls, execute };
}

function expectNoTokenLeak(value: string) {
  expect(value).not.toContain(FAKE_TOKEN);
}

describe("GOOGLE_SENSITIVE_TOOLS", () => {
  it("exposes the eight sensitive-scope tools", () => {
    expect(GOOGLE_SENSITIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "read_google_sheet",
      "write_google_sheet",
      "read_google_doc",
      "append_google_doc",
      "read_google_slides",
      "add_google_slide",
      "list_calendar_events",
      "create_calendar_event"
    ]);
  });
});

describe("createGoogleSensitiveExecutor", () => {
  it("reads a user-referenced sheet by URL with the default range", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({ range: "Sheet1!A1:Z1000", values: [["x"]] })]);
    const outcome = await execute("read_google_sheet", { url: SHEET_URL }, {});
    expect(outcome.isError).toBeFalsy();
    expect(JSON.parse(outcome.content)).toEqual({ range: "Sheet1!A1:Z1000", values: [["x"]] });
    expect(calls[0].url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("A1:Z1000")}`
    );
  });

  it("writes a user-referenced sheet by URL and reports the cell count", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({ updatedCells: 4 })]);
    const outcome = await execute(
      "write_google_sheet",
      { url: SHEET_URL, range: "A1:B2", values: [["a", "b"], ["c", "d"]] },
      {}
    );
    expect(JSON.parse(outcome.content)).toEqual({ updatedCells: 4 });
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toContain(`/v4/spreadsheets/${SHEET_ID}/values/`);
    expect(calls[0].url).toContain("valueInputOption=RAW");
  });

  it("reads a doc's title and body text", async () => {
    const { execute } = recordingExecutor([
      jsonResponse({
        title: "Plan",
        body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Line one\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "Line two\n" } }] } }
        ] }
      })
    ]);
    const outcome = await execute("read_google_doc", { url: DOC_URL }, {});
    expect(JSON.parse(outcome.content)).toEqual({ title: "Plan", text: "Line one\nLine two\n" });
  });

  it("appends text to a user-referenced doc just before the trailing newline", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } }),
      jsonResponse({})
    ]);
    const outcome = await execute("append_google_doc", { url: DOC_URL, text: "More" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(calls[1].url).toBe(`https://docs.googleapis.com/v1/documents/${SHEET_ID}:batchUpdate`);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      requests: [{ insertText: { location: { index: 41 }, text: "More" } }]
    });
  });

  it("reads a presentation's title and slide count", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ title: "Deck", slides: [{ objectId: "s1" }, { objectId: "s2" }] })
    ]);
    const outcome = await execute("read_google_slides", { url: DECK_URL }, {});
    expect(JSON.parse(outcome.content)).toEqual({ title: "Deck", slideCount: 2, slideObjectIds: ["s1", "s2"] });
    expect(calls[0].url).toBe(
      `https://slides.googleapis.com/v1/presentations/${SHEET_ID}?fields=title,slides(objectId)`
    );
  });

  it("adds a titled slide with body text via a single batchUpdate", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({})]);
    const outcome = await execute("add_google_slide", { url: DECK_URL, title: "Q3", body: "Revenue up" }, {});
    expect(JSON.parse(outcome.content)).toEqual({ presentationId: SHEET_ID, slideObjectId: "id1" });
    expect(calls[0].url).toBe(`https://slides.googleapis.com/v1/presentations/${SHEET_ID}:batchUpdate`);
    const requests = JSON.parse(String(calls[0].init.body)).requests;
    expect(requests[0].createSlide.objectId).toBe("id1");
    expect(requests[0].createSlide.placeholderIdMappings).toHaveLength(2);
    expect(requests[1]).toEqual({ insertText: { objectId: "id2", text: "Q3" } });
    expect(requests[2]).toEqual({ insertText: { objectId: "id3", text: "Revenue up" } });
  });

  it("omits the body insert when no body text is given", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({})]);
    await execute("add_google_slide", { url: DECK_URL, title: "Just a title" }, {});
    const requests = JSON.parse(String(calls[0].init.body)).requests;
    expect(requests).toHaveLength(2);
  });

  it("lists calendar events with a bounded window and result cap", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-07-21T09:00:00Z" }, end: { dateTime: "2026-07-21T09:15:00Z" }, htmlLink: "https://cal/e1" }] })
    ]);
    const outcome = await execute(
      "list_calendar_events",
      { timeMin: "2026-07-21T00:00:00Z", timeMax: "2026-07-22T00:00:00Z", maxResults: 5 },
      {}
    );
    const events = JSON.parse(outcome.content).events;
    expect(events[0]).toMatchObject({ id: "e1", summary: "Standup" });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("5");
    expect(url.searchParams.get("timeMin")).toBe("2026-07-21T00:00:00Z");
  });

  it("creates a calendar event without inviting anyone or sending notifications", async () => {
    const { calls, execute } = recordingExecutor([
      jsonResponse({ id: "evt-1", htmlLink: "https://cal/evt-1" })
    ]);
    const outcome = await execute(
      "create_calendar_event",
      {
        summary: "Design review",
        startDateTime: "2026-07-22T14:00:00+09:00",
        endDateTime: "2026-07-22T15:00:00+09:00",
        description: "Go over the diff",
        timeZone: "Asia/Tokyo"
      },
      {}
    );
    expect(JSON.parse(outcome.content)).toMatchObject({ id: "evt-1", summary: "Design review" });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain("sendUpdates=none");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({
      summary: "Design review",
      description: "Go over the diff",
      start: { dateTime: "2026-07-22T14:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-22T15:00:00+09:00", timeZone: "Asia/Tokyo" }
    });
    expect(sent).not.toHaveProperty("attendees");
  });

  it("sends the token only in the Authorization header and never leaks it", async () => {
    const { calls, execute } = recordingExecutor([jsonResponse({ range: "A1", values: [] })]);
    const outcome = await execute("read_google_sheet", { url: SHEET_URL }, {});
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls[0].url).not.toContain(FAKE_TOKEN);
    expectNoTokenLeak(outcome.content);
  });

  it("binds the default fetch so the browser never sees an illegal `this`", async () => {
    const original = globalThis.fetch;
    // Simulate Chrome's window.fetch, which rejects any `this` other than the global.
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse({ range: "A1", values: [] }));
    } as typeof fetch;
    try {
      const execute = createGoogleSensitiveExecutor(async () => FAKE_TOKEN);
      const outcome = await execute("read_google_sheet", { url: SHEET_URL }, {});
      expect(outcome.isError).toBeFalsy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("preserves the underlying cause when the request throws before completion", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const execute = createGoogleSensitiveExecutor(async () => FAKE_TOKEN, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const outcome = await execute("read_google_sheet", { url: SHEET_URL }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("TypeError: Failed to fetch");
    expectNoTokenLeak(outcome.content);
  });

  it("maps a 403 insufficient-scope failure to a plain-language error", async () => {
    const { execute } = recordingExecutor([jsonResponse({ error: { message: "insufficient" } }, 403)]);
    const outcome = await execute("read_google_doc", { url: DOC_URL }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/denied this request/);
    expectNoTokenLeak(outcome.content);
  });

  it("rejects invalid arguments without making requests", async () => {
    const { calls, execute } = recordingExecutor([]);
    expect((await execute("read_google_sheet", { url: "not a url" }, {})).isError).toBe(true);
    expect((await execute("read_google_doc", { url: SHEET_URL }, {})).isError).toBe(true); // Sheet URL to Doc tool
    expect((await execute("create_calendar_event", { summary: "x", startDateTime: "nope", endDateTime: "2026-07-22T15:00:00Z" }, {})).isError).toBe(true);
    expect((await execute("create_calendar_event", { summary: "", startDateTime: "2026-07-22T14:00:00Z", endDateTime: "2026-07-22T15:00:00Z" }, {})).isError).toBe(true);
    expect((await execute("list_calendar_events", { maxResults: 999 }, {})).isError).toBe(true);
    expect((await execute("mystery_tool", {}, {})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const { execute } = recordingExecutor([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      execute("read_google_sheet", { url: SHEET_URL }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
