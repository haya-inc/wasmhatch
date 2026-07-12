# WasmHatch Connector Authoring

> Versioned, testable business operations without credential-bearing connector
> code.

- Contract status: experimental public API introduced in WasmHatch 0.16.0
- Manifest schema: 1
- Current core: `0.30.0`; bundled connector compatibility: `>=0.16.0 <1.0.0`
- Source: [`src/lib/connector.ts`](../src/lib/connector.ts)

## Why this contract exists

A connector is a domain adapter, not an authenticated HTTP client. It should
translate typed business input into a narrow provider operation and validate the
provider response. It should not receive OAuth tokens, choose arbitrary network
destinations, add authorization headers, or turn model output into authority.

The WasmHatch host owns a `CredentialBroker`. Connector code receives a frozen
`ConnectorTransport` containing only:

```ts
interface ConnectorTransport {
  readonly connectorId: string;
  readonly connectorVersion: string;
  request(request: ConnectorRequest): Promise<Response>;
}
```

Before sending, the broker validates the operation name, bound path resources,
origin, method, path, query parameters, request headers, body mode, media types,
and byte limits against the manifest and host grant. It then resolves a
host-only credential provider and attaches the authorization header. Redirects,
cookies, ambient browser credentials, and referrers are disabled.

## Manifest shape

Use `defineConnectorManifest` so invalid or incompatible manifests fail at
module initialization:

```ts
import {
  CONNECTOR_MANIFEST_SCHEMA_VERSION,
  defineConnectorManifest
} from "../src/lib/connector";

export const EXAMPLE_MANIFEST = defineConnectorManifest({
  schemaVersion: CONNECTOR_MANIFEST_SCHEMA_VERSION,
  id: "example-records",
  label: "Example Records",
  version: "1.0.0",
  compatibleCore: {
    minInclusive: "0.16.0",
    maxExclusive: "1.0.0"
  },
  auth: { kind: "bearer", label: "Example OAuth access token" },
  allowedOrigins: ["https://api.example.com"],
  operations: [{
    id: "read-record",
    effect: "read",
    transport: "http",
    retry: "idempotent",
    precondition: "none",
    http: {
      method: "GET",
      pathTemplate: "/v1/records/{recordId}",
      allowedQuery: ["fields"],
      allowedRequestHeaders: [],
      requestBody: "none",
      requestContentTypes: [],
      responseContentTypes: ["application/json"],
      maxRequestBytes: 0,
      maxResponseBytes: 256 * 1024
    }
  }]
});
```

Manifest objects and nested arrays are deeply frozen. Unknown fields, duplicate
IDs, unstable version strings, unsafe origins or path templates, credential
headers, and unsupported core ranges are rejected. HTTP origins must be exact
HTTPS origins. CSP still needs the same origin; the broker is an additional
runtime boundary, not a CSP replacement.

## Operation rules

Every operation declares five independent properties:

| Field | Meaning |
| --- | --- |
| `effect` | `read`, `compute`, `prepare`, or durable `commit` |
| `transport` | local code or brokered HTTP |
| `retry` | `idempotent` or `never`; this is not inferred from HTTP method |
| `precondition` | provider `atomic`, disclosed `recheck`, or blocked-by-default `none` |
| `http` | the exact network capability, or `null` for local operations |

Path placeholders occupy one path segment. Connector input must be encoded with
`encodeURIComponent` before substitution. Query keys and request header names
are allowlisted separately. Body presence, request media types, response media
types, and byte limits are explicit. Unknown request fields are rejected.
Connector code cannot supply `Authorization`, `Cookie`, `Proxy-Authorization`,
or `Set-Cookie`.

Do not combine unrelated business effects into one broad operation. For
example, email draft creation and email send need separate operations and
separate proposals even if the provider exposes one generic message endpoint.

## Connector implementation

A connector constructor accepts a transport, verifies that its public identity
matches the connector manifest, and keeps business methods typed:

```ts
class ExampleConnector {
  readonly manifest = EXAMPLE_MANIFEST;

  constructor(private readonly transport: ConnectorTransport) {
    if (
      transport.connectorId !== this.manifest.id ||
      transport.connectorVersion !== this.manifest.version
    ) {
      throw new Error("Connector transport does not match its manifest.");
    }
  }

  async readRecord(recordId: string, signal?: AbortSignal) {
    const response = await this.transport.request({
      operationId: "read-record",
      url: `https://api.example.com/v1/records/${encodeURIComponent(recordId)}`,
      method: "GET",
      signal
    });
    if (!response.ok) throw new Error(`Record read failed (${response.status}).`);
    return response.json();
  }
}
```

The connector never accepts a token or raw `fetch`. Only the application host
creates a credential provider and binds it to the manifest:

```ts
const transport = credentialBroker.bind(
  EXAMPLE_MANIFEST,
  createBearerCredentialProvider(() => oauthHost.getValidAccessToken()),
  {
    operations: ["read-record"],
    pathParameters: { recordId: [selectedRecordId] }
  }
);
const connector = new ExampleConnector(transport);
```

The callback is evaluated per request. It may refresh a short-lived token in the
host, but must not expose refresh tokens or access tokens to connector, model,
script, log, or persisted workspace data.

## Fixture testing

Use `createConnectorFixtureTransport` to exercise the real manifest boundary
without credentials, network, React, or the application shell:

```ts
const transport = createConnectorFixtureTransport(
  EXAMPLE_MANIFEST,
  {
    operations: ["read-record"],
    pathParameters: { recordId: ["record-1"] }
  },
  {
    "read-record": async (request) => {
      expect(request.url).toBe("https://api.example.com/v1/records/record-1");
      expect(request.headers).not.toHaveProperty("authorization");
      return new Response(JSON.stringify({ id: "record-1", status: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  }
);

const connector = new ExampleConnector(transport);
expect(await connector.readRecord("record-1")).toMatchObject({ status: "open" });
```

Fixtures still reject ungranted operations or resources, undeclared origins,
methods, paths, queries, headers, media types, and oversized responses. A
fixture is not a bypass around the contract.

## Required tests for a contribution

A connector contribution should prove:

1. its manifest passes the current core validator and is compatible with the
   oldest core release it claims;
2. unknown provider input and response fields fail explicitly or are safely
   ignored by a documented forward-compatibility rule;
3. every operation has success, provider rejection, cancellation, and size-limit
   fixtures;
4. durable effects declare retry and precondition semantics and integrate with
   immutable proposals rather than calling commit from model output;
5. authorization text is absent from connector constructor arguments, fixture
   requests, errors, logs, model input, and script input;
6. binding grants prove that connector calls cannot switch from the selected
   resource to another account object, file, document, sheet, range, or record;
7. all origins and CSP additions are minimal and justified;
8. user-visible review describes the provider-specific destination and effect.

## Trust boundary and current limitation

The broker makes credential use capability-scoped, but it does not sandbox
arbitrary JavaScript loaded into the application realm. WasmHatch currently
accepts reviewed, bundled connector code only. Dynamic installation of untrusted
connector packages requires an isolated Worker or realm, signed package
metadata, and the same manifest/broker protocol across that boundary.

Do not interpret manifest validation as permission to load unknown npm packages
into the operator page.

## Versioning

- Increment connector patch versions for compatible fixes and fixture additions.
- Increment minor versions for optional operations or optional fields.
- Increment major versions when saved operation input, output, effect, target,
  auth, retry, or precondition semantics change incompatibly.
- Narrow `compatibleCore` when a connector depends on a new broker invariant.
- Never silently reinterpret an existing operation ID.

The repository tests require `CONNECTOR_CORE_VERSION` to match the application
package version, preventing a release from advertising stale compatibility.
