import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import {
  CONNECTOR_CORE_VERSION,
  CredentialBroker,
  GOOGLE_SHEETS_MANIFEST,
  LOCAL_SPREADSHEET_MANIFEST,
  ConnectorContractError,
  createBearerCredentialProvider,
  createConnectorFixtureTransport,
  createMemoryBearerCredential,
  validateConnectorManifest,
  type ConnectorManifest
} from "./connector";

function cloneManifest(manifest: ConnectorManifest = GOOGLE_SHEETS_MANIFEST) {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function readRequest(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "read-range",
    url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Ops!A1%3AB2?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE",
    method: "GET",
    ...overrides
  } as never;
}

const READ_GRANT = {
  operations: ["read-range"],
  pathParameters: { spreadsheetId: ["sheet-1"], range: ["Ops!A1:B2"] }
} as const;

const READ_WRITE_GRANT = {
  operations: ["read-range", "write-range"],
  pathParameters: { spreadsheetId: ["sheet-1"], range: ["Ops!A1:B2"] }
} as const;

describe("connector manifest validation", () => {
  it("publishes frozen local and Google manifests compatible with the current core", () => {
    expect(CONNECTOR_CORE_VERSION).toBe("0.20.0");
    expect(packageJson.version).toBe(CONNECTOR_CORE_VERSION);
    expect(validateConnectorManifest(LOCAL_SPREADSHEET_MANIFEST)).toBeTruthy();
    expect(validateConnectorManifest(GOOGLE_SHEETS_MANIFEST)).toBeTruthy();
    expect(Object.isFrozen(GOOGLE_SHEETS_MANIFEST)).toBe(true);
    expect(Object.isFrozen(GOOGLE_SHEETS_MANIFEST.operations)).toBe(true);
    expect(GOOGLE_SHEETS_MANIFEST.allowedOrigins).toEqual(["https://sheets.googleapis.com"]);
  });

  it("rejects unknown fields at manifest, operation, HTTP, and auth boundaries", () => {
    const top = { ...cloneManifest(), unexpected: true };
    const operation = cloneManifest();
    (operation.operations as Array<Record<string, unknown>>)[0].unexpected = true;
    const http = cloneManifest();
    ((http.operations as Array<Record<string, unknown>>)[0].http as Record<string, unknown>).unexpected = true;
    const auth = cloneManifest();
    (auth.auth as Record<string, unknown>).token = "must never be a manifest field";

    for (const value of [top, operation, http, auth]) {
      expect(() => validateConnectorManifest(value)).toThrow("missing or unsupported fields");
    }
  });

  it("rejects incompatible cores and invalid semantic ranges", () => {
    expect(() => validateConnectorManifest(GOOGLE_SHEETS_MANIFEST, "0.15.0"))
      .toThrow("requires WasmHatch core >=0.16.0");
    expect(() => validateConnectorManifest(GOOGLE_SHEETS_MANIFEST, "1.0.0"))
      .toThrow("current core is 1.0.0");

    const empty = cloneManifest();
    empty.compatibleCore = { minInclusive: "1.0.0", maxExclusive: "1.0.0" };
    expect(() => validateConnectorManifest(empty, "1.0.0")).toThrow("range is empty");

    const prerelease = cloneManifest();
    prerelease.version = "1.0.0-beta.1";
    expect(() => validateConnectorManifest(prerelease)).toThrow("stable semantic version");
  });

  it("rejects unsafe origin, path, header, and duplicate operation grants", () => {
    const origin = cloneManifest();
    origin.allowedOrigins = ["http://sheets.googleapis.com"];
    expect(() => validateConnectorManifest(origin)).toThrow("HTTPS origins");

    const path = cloneManifest();
    ((path.operations as Array<Record<string, unknown>>)[0].http as Record<string, unknown>).pathTemplate = "/v4/../secrets";
    expect(() => validateConnectorManifest(path)).toThrow("unsafe segment");

    const header = cloneManifest();
    ((header.operations as Array<Record<string, unknown>>)[0].http as Record<string, unknown>).allowedRequestHeaders = ["authorization"];
    expect(() => validateConnectorManifest(header)).toThrow("cannot grant the authorization header");

    const duplicate = cloneManifest();
    const operations = duplicate.operations as Array<Record<string, unknown>>;
    operations.push(JSON.parse(JSON.stringify(operations[0])) as Record<string, unknown>);
    expect(() => validateConnectorManifest(duplicate)).toThrow("IDs must be unique");
  });
});

describe("CredentialBroker", () => {
  it("keeps credential text outside connector-visible transport and attaches it only after validation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ values: [["A"]] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const broker = new CredentialBroker(fetcher);
    const transport = broker.bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret-access-token"),
      READ_GRANT
    );

    expect(Object.keys(transport).sort()).toEqual(["connectorId", "connectorVersion", "request"]);
    expect(JSON.stringify(transport)).not.toContain("secret-access-token");
    expect(String(transport.request)).not.toContain("secret-access-token");

    const response = await transport.request(readRequest());
    expect(await response.json()).toEqual({ values: [["A"]] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toContain("sheets.googleapis.com/v4/spreadsheets/sheet-1/values/");
    expect(headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
  });

  it("resolves credentials per request so a host provider can refresh without exposing tokens", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const tokens = ["token-one", "token-two"];
    const provider = createBearerCredentialProvider(() => tokens.shift() ?? "token-three");
    const transport = new CredentialBroker(fetcher).bind(GOOGLE_SHEETS_MANIFEST, provider, READ_GRANT);

    await transport.request(readRequest());
    await transport.request(readRequest());

    const firstHeaders = new Headers((fetcher.mock.calls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((fetcher.mock.calls[1][1] as RequestInit).headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer token-one");
    expect(secondHeaders.get("authorization")).toBe("Bearer token-two");
    expect(JSON.stringify(transport)).not.toContain("token-one");
  });

  it.each([
    ["origin", readRequest({ url: "https://example.com/v4/spreadsheets/sheet-1/values/A1" }), "origin_not_allowed"],
    ["path", readRequest({ url: "https://sheets.googleapis.com/v4/files/sheet-1" }), "path_not_allowed"],
    ["query", readRequest({ url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Ops!A1%3AB2?alt=media" }), "query_not_allowed"],
    ["method", readRequest({ method: "POST" }), "method_not_allowed"],
    ["header", readRequest({ headers: { authorization: "Bearer attacker" } }), "header_not_allowed"],
    ["body", readRequest({ body: "not allowed" }), "body_not_allowed"]
  ])("rejects undeclared %s capabilities before fetch", async (_label, request, code) => {
    const fetcher = vi.fn();
    const transport = new CredentialBroker(fetcher).bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret"),
      READ_GRANT
    );

    await expect(transport.request(request)).rejects.toMatchObject({ code });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces declared response limits before connector parsing", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", {
      status: 200,
      headers: { "content-length": String(3 * 1024 * 1024) }
    }));
    const transport = new CredentialBroker(fetcher).bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret"),
      READ_GRANT
    );

    await expect(transport.request(readRequest())).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("binds each transport to explicit operations and path resources", async () => {
    const fetcher = vi.fn();
    const broker = new CredentialBroker(fetcher);
    const transport = broker.bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret"),
      READ_GRANT
    );

    await expect(transport.request(readRequest({
      url: "https://sheets.googleapis.com/v4/spreadsheets/another-sheet/values/Ops!A1%3AB2"
    }))).rejects.toMatchObject({ code: "resource_not_granted" });
    await expect(transport.request(readRequest({
      url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Other!A1%3AB2"
    }))).rejects.toMatchObject({ code: "resource_not_granted" });
    await expect(transport.request({
      operationId: "write-range",
      url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Ops!A1%3AB2?valueInputOption=RAW",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}"
    })).rejects.toMatchObject({ code: "operation_not_granted" });
    expect(fetcher).not.toHaveBeenCalled();

    expect(() => broker.bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret"),
      { operations: ["read-range"], pathParameters: { spreadsheetId: ["sheet-1"] } }
    )).toThrow("exactly cover operation placeholders");
  });

  it("rejects unknown request fields, missing write bodies, and undeclared media types", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("<html />", {
      status: 200,
      headers: { "content-type": "text/html" }
    }));
    const transport = new CredentialBroker(fetcher).bind(
      GOOGLE_SHEETS_MANIFEST,
      createMemoryBearerCredential("secret"),
      READ_WRITE_GRANT
    );
    const writeUrl = "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Ops!A1%3AB2?valueInputOption=RAW";

    await expect(transport.request(readRequest({ unexpected: true })))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(transport.request({ operationId: "write-range", url: writeUrl, method: "PUT" }))
      .rejects.toMatchObject({ code: "body_required" });
    await expect(transport.request({
      operationId: "write-range",
      url: writeUrl,
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{}"
    })).rejects.toMatchObject({ code: "content_type_not_allowed" });
    await expect(transport.request(readRequest())).rejects.toMatchObject({ code: "content_type_not_allowed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, invalid, or unnecessary credential providers", async () => {
    const broker = new CredentialBroker(vi.fn());
    expect(() => broker.bind(GOOGLE_SHEETS_MANIFEST, undefined, READ_GRANT)).toThrow("requires a bearer credential provider");
    expect(() => broker.bind(LOCAL_SPREADSHEET_MANIFEST, createMemoryBearerCredential("secret"), READ_GRANT))
      .toThrow("does not accept credentials");

    const transport = broker.bind(
      GOOGLE_SHEETS_MANIFEST,
      createBearerCredentialProvider(() => "invalid\ntoken"),
      READ_GRANT
    );
    await expect(transport.request(readRequest())).rejects.toMatchObject({ code: "credential_unavailable" });
  });
});

describe("connector fixtures", () => {
  it("runs a manifest-validated operation fixture without credentials, network, or application UI", async () => {
    const handler = vi.fn(async (request) => {
      expect(request.operation.id).toBe("read-range");
      expect(request.headers).not.toHaveProperty("authorization");
      return new Response(JSON.stringify({ range: "Ops!A1:B2", values: [["Owner", "Amount"], ["Aya", 42]] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const transport = createConnectorFixtureTransport(GOOGLE_SHEETS_MANIFEST, READ_GRANT, { "read-range": handler });

    const response = await transport.request(readRequest());

    expect(await response.json()).toMatchObject({ range: "Ops!A1:B2" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still rejects an invalid connector request before invoking a fixture", async () => {
    const handler = vi.fn();
    const transport = createConnectorFixtureTransport(GOOGLE_SHEETS_MANIFEST, READ_GRANT, { "read-range": handler });

    await expect(transport.request(readRequest({ url: "https://evil.example/v4/spreadsheets/x/values/A1" })))
      .rejects.toBeInstanceOf(ConnectorContractError);
    expect(handler).not.toHaveBeenCalled();
  });
});
