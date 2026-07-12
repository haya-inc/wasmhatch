export const CONNECTOR_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CONNECTOR_CORE_VERSION = "0.42.0";

export type ConnectorEffect = "read" | "compute" | "prepare" | "commit";
export type ConnectorRetry = "never" | "idempotent";
export type ConnectorPrecondition = "atomic" | "recheck" | "none";
export type ConnectorTransportKind = "local" | "http";

export interface ConnectorCompatibility {
  readonly minInclusive: string;
  readonly maxExclusive: string;
}

export type ConnectorAuthManifest =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly label: string };

export interface ConnectorHttpOperation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly pathTemplate: string;
  readonly allowedQuery: readonly string[];
  readonly allowedRequestHeaders: readonly string[];
  readonly requestBody: "none" | "optional" | "required";
  readonly requestContentTypes: readonly string[];
  readonly responseContentTypes: readonly string[];
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export interface ConnectorOperationManifest {
  readonly id: string;
  readonly effect: ConnectorEffect;
  readonly transport: ConnectorTransportKind;
  readonly retry: ConnectorRetry;
  readonly precondition: ConnectorPrecondition;
  readonly http: ConnectorHttpOperation | null;
}

export interface ConnectorManifest {
  readonly schemaVersion: typeof CONNECTOR_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly compatibleCore: ConnectorCompatibility;
  readonly auth: ConnectorAuthManifest;
  readonly allowedOrigins: readonly string[];
  readonly operations: readonly ConnectorOperationManifest[];
}

export interface BearerCredentialProvider {
  readonly kind: "bearer";
  getToken(signal?: AbortSignal): Promise<string>;
}

export interface ConnectorBindingGrant {
  readonly operations: readonly string[];
  readonly pathParameters: Readonly<Record<string, readonly string[]>>;
}

export interface ConnectorRequest {
  operationId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ConnectorTransport {
  readonly connectorId: string;
  readonly connectorVersion: string;
  request(request: ConnectorRequest): Promise<Response>;
}

export interface ConnectorFixtureRequest {
  readonly operation: ConnectorOperationManifest;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type ConnectorFixtureHandlers = Record<
  string,
  (request: ConnectorFixtureRequest) => Response | Promise<Response>
>;

export class ConnectorContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConnectorContractError";
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const QUERY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const HEADER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PLACEHOLDER_PATTERN = /^\{[A-Za-z][A-Za-z0-9]*\}$/;
const LITERAL_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_CREDENTIAL_LENGTH = 16 * 1024;
const MAX_URL_LENGTH = 8 * 1024;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function contractError(code: string, message: string): never {
  throw new ConnectorContractError(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) contractError("invalid_manifest", `${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    contractError("invalid_manifest", `${label} contains missing or unsupported fields.`);
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) contractError("invalid_request", `${label} field ${unknown} is unsupported.`);
}

function containsControlCharacters(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireText(value: unknown, label: string, maxLength = 256) {
  if (typeof value !== "string") contractError("invalid_manifest", `${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) contractError("invalid_manifest", `${label} is required.`);
  if (normalized.length > maxLength) contractError("invalid_manifest", `${label} is too long.`);
  if (containsControlCharacters(normalized)) contractError("invalid_manifest", `${label} contains control characters.`);
  return normalized;
}

function requireId(value: unknown, label: string) {
  const id = requireText(value, label, 64);
  if (!ID_PATTERN.test(id)) contractError("invalid_manifest", `${label} must use lower-case kebab syntax.`);
  return id;
}

function parseVersion(value: unknown, label: string) {
  const version = requireText(value, label, 64);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) contractError("invalid_version", `${label} must be a stable semantic version.`);
  return { value: version, parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const };
}

function compareVersions(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    contractError("invalid_manifest", `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function requireStringArray(
  value: unknown,
  label: string,
  validate: (entry: string) => string
) {
  if (!Array.isArray(value)) contractError("invalid_manifest", `${label} must be an array.`);
  const entries = value.map((entry) => validate(requireText(entry, `${label} entry`, 2048)));
  if (new Set(entries).size !== entries.length) contractError("invalid_manifest", `${label} contains duplicates.`);
  return entries;
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return contractError("invalid_manifest", "Connector origin is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    contractError("invalid_manifest", "Connector origins must be HTTPS origins without credentials, paths, queries, or fragments.");
  }
  return url.origin;
}

function normalizeHeaderName(value: string) {
  const header = value.toLowerCase();
  if (!HEADER_PATTERN.test(header)) contractError("invalid_manifest", "Allowed request header name is invalid.");
  if (["authorization", "cookie", "proxy-authorization", "set-cookie"].includes(header)) {
    contractError("invalid_manifest", `Connector manifests cannot grant the ${header} header.`);
  }
  return header;
}

function normalizeQueryName(value: string) {
  if (!QUERY_PATTERN.test(value)) contractError("invalid_manifest", "Allowed query parameter name is invalid.");
  return value;
}

function normalizeMediaType(value: string) {
  const mediaType = value.toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) contractError("invalid_manifest", "Connector media type is invalid.");
  return mediaType;
}

function normalizePathTemplate(value: unknown) {
  const template = requireText(value, "Connector path template", 512);
  if (!template.startsWith("/") || template.includes("?") || template.includes("#") || template.includes("\\")) {
    contractError("invalid_manifest", "Connector path template must be an absolute URL path without query or fragment syntax.");
  }
  const segments = template.slice(1).split("/");
  if (!segments.length || segments.some((segment) => !segment)) {
    contractError("invalid_manifest", "Connector path template cannot contain empty segments.");
  }
  const placeholders = new Set<string>();
  for (const segment of segments) {
    if (PLACEHOLDER_PATTERN.test(segment)) {
      if (placeholders.has(segment)) contractError("invalid_manifest", "Connector path placeholders must be unique.");
      placeholders.add(segment);
    } else if (!LITERAL_PATH_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      contractError("invalid_manifest", "Connector path template contains an unsafe segment.");
    }
  }
  return template;
}

function matchPath(template: string, pathname: string) {
  const expected = template.slice(1).split("/");
  const actual = pathname.slice(1).split("/");
  if (expected.length !== actual.length) return null;
  const parameters: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (PLACEHOLDER_PATTERN.test(segment)) {
      if (!actual[index]) return null;
      const name = segment.slice(1, -1);
      try {
        parameters[name] = decodeURIComponent(actual[index]);
      } catch {
        return null;
      }
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return parameters;
}

function templatePlaceholders(template: string) {
  return template.slice(1).split("/")
    .filter((segment) => PLACEHOLDER_PATTERN.test(segment))
    .map((segment) => segment.slice(1, -1));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function validateCompatibility(value: unknown, coreVersion: string): ConnectorCompatibility {
  assertExactKeys(value, ["minInclusive", "maxExclusive"], "Connector compatibility");
  const minimum = parseVersion(value.minInclusive, "Minimum compatible core");
  const maximum = parseVersion(value.maxExclusive, "Maximum compatible core");
  const core = parseVersion(coreVersion, "WasmHatch core version");
  if (compareVersions(minimum.parts, maximum.parts) >= 0) {
    contractError("invalid_compatibility", "Connector compatibility range is empty.");
  }
  if (compareVersions(core.parts, minimum.parts) < 0 || compareVersions(core.parts, maximum.parts) >= 0) {
    contractError(
      "incompatible_core",
      `Connector requires WasmHatch core >=${minimum.value} and <${maximum.value}; current core is ${core.value}.`
    );
  }
  return { minInclusive: minimum.value, maxExclusive: maximum.value };
}

function validateAuth(value: unknown): ConnectorAuthManifest {
  if (!isPlainRecord(value) || (value.kind !== "none" && value.kind !== "bearer")) {
    contractError("invalid_manifest", "Connector auth kind must be none or bearer.");
  }
  if (value.kind === "none") {
    assertExactKeys(value, ["kind"], "Connector auth");
    return { kind: "none" };
  }
  assertExactKeys(value, ["kind", "label"], "Connector auth");
  return { kind: "bearer", label: requireText(value.label, "Connector auth label", 128) };
}

function validateHttpOperation(value: unknown): ConnectorHttpOperation {
  assertExactKeys(value, [
    "method", "pathTemplate", "allowedQuery", "allowedRequestHeaders",
    "requestBody", "requestContentTypes", "responseContentTypes",
    "maxRequestBytes", "maxResponseBytes"
  ], "Connector HTTP operation");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(value.method))) {
    contractError("invalid_manifest", "Connector HTTP method is unsupported.");
  }
  const requestBody = String(value.requestBody);
  if (requestBody !== "none" && requestBody !== "optional" && requestBody !== "required") {
    contractError("invalid_manifest", "Connector request body mode is unsupported.");
  }
  const allowedRequestHeaders = requireStringArray(value.allowedRequestHeaders, "Allowed request headers", normalizeHeaderName);
  const requestContentTypes = requireStringArray(value.requestContentTypes, "Request content types", normalizeMediaType);
  const responseContentTypes = requireStringArray(value.responseContentTypes, "Response content types", normalizeMediaType);
  const maxRequestBytes = requireInteger(value.maxRequestBytes, "Maximum request bytes", 0, MAX_REQUEST_BYTES);
  if (requestBody === "none" && (maxRequestBytes !== 0 || requestContentTypes.length !== 0)) {
    contractError("invalid_manifest", "Bodyless operations require zero request bytes and no request content types.");
  }
  if (requestBody !== "none" && (maxRequestBytes === 0 || requestContentTypes.length === 0 || !allowedRequestHeaders.includes("content-type"))) {
    contractError("invalid_manifest", "Operations with bodies require a byte limit, content types, and the content-type header.");
  }
  return {
    method: value.method as ConnectorHttpOperation["method"],
    pathTemplate: normalizePathTemplate(value.pathTemplate),
    allowedQuery: requireStringArray(value.allowedQuery, "Allowed query parameters", normalizeQueryName),
    allowedRequestHeaders,
    requestBody: requestBody as ConnectorHttpOperation["requestBody"],
    requestContentTypes,
    responseContentTypes,
    maxRequestBytes,
    maxResponseBytes: requireInteger(value.maxResponseBytes, "Maximum response bytes", 1, MAX_RESPONSE_BYTES)
  };
}

function validateOperation(value: unknown): ConnectorOperationManifest {
  assertExactKeys(value, ["id", "effect", "transport", "retry", "precondition", "http"], "Connector operation");
  const effect = String(value.effect);
  const transport = String(value.transport);
  const retry = String(value.retry);
  const precondition = String(value.precondition);
  if (!["read", "compute", "prepare", "commit"].includes(effect)) contractError("invalid_manifest", "Connector effect is unsupported.");
  if (transport !== "local" && transport !== "http") contractError("invalid_manifest", "Connector transport is unsupported.");
  if (retry !== "never" && retry !== "idempotent") contractError("invalid_manifest", "Connector retry class is unsupported.");
  if (!["atomic", "recheck", "none"].includes(precondition)) contractError("invalid_manifest", "Connector precondition is unsupported.");
  if (transport === "local" && value.http !== null) contractError("invalid_manifest", "Local connector operations cannot declare HTTP access.");
  if (transport === "http" && value.http === null) contractError("invalid_manifest", "HTTP connector operations require an HTTP boundary.");
  return {
    id: requireId(value.id, "Connector operation ID"),
    effect: effect as ConnectorEffect,
    transport: transport as ConnectorTransportKind,
    retry: retry as ConnectorRetry,
    precondition: precondition as ConnectorPrecondition,
    http: value.http === null ? null : validateHttpOperation(value.http)
  };
}

export function validateConnectorManifest(
  value: unknown,
  coreVersion = CONNECTOR_CORE_VERSION
): ConnectorManifest {
  let manifestBytes = 0;
  try {
    manifestBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    contractError("invalid_manifest", "Connector manifest must be JSON serializable.");
  }
  if (manifestBytes > MAX_MANIFEST_BYTES) contractError("invalid_manifest", "Connector manifest is too large.");
  assertExactKeys(value, [
    "schemaVersion", "id", "label", "version", "compatibleCore", "auth", "allowedOrigins", "operations"
  ], "Connector manifest");
  if (value.schemaVersion !== CONNECTOR_MANIFEST_SCHEMA_VERSION) {
    contractError("invalid_manifest", "Connector manifest schema version is unsupported.");
  }
  const version = parseVersion(value.version, "Connector version").value;
  const compatibleCore = validateCompatibility(value.compatibleCore, coreVersion);
  const auth = validateAuth(value.auth);
  const allowedOrigins = requireStringArray(value.allowedOrigins, "Connector allowed origins", normalizeOrigin);
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 128) {
    contractError("invalid_manifest", "Connector operations must contain 1 to 128 entries.");
  }
  const operations = value.operations.map(validateOperation);
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
    contractError("invalid_manifest", "Connector operation IDs must be unique.");
  }
  if (operations.some((operation) => operation.transport === "http") && allowedOrigins.length === 0) {
    contractError("invalid_manifest", "HTTP connector operations require at least one allowed origin.");
  }
  if (!operations.some((operation) => operation.transport === "http") && allowedOrigins.length !== 0) {
    contractError("invalid_manifest", "Local-only connectors cannot declare network origins.");
  }
  return deepFreeze({
    schemaVersion: CONNECTOR_MANIFEST_SCHEMA_VERSION,
    id: requireId(value.id, "Connector ID"),
    label: requireText(value.label, "Connector label", 128),
    version,
    compatibleCore,
    auth,
    allowedOrigins,
    operations
  });
}

export function defineConnectorManifest(value: ConnectorManifest): ConnectorManifest {
  return validateConnectorManifest(value);
}

function validateBearerToken(value: unknown) {
  if (typeof value !== "string") contractError("credential_unavailable", "Connector credential provider returned no token.");
  const token = value.trim();
  if (!token || token.length > MAX_CREDENTIAL_LENGTH || containsControlCharacters(token)) {
    contractError("credential_unavailable", "Connector credential provider returned an invalid token.");
  }
  return token;
}

export function createBearerCredentialProvider(
  getToken: (signal?: AbortSignal) => string | Promise<string>
): BearerCredentialProvider {
  if (typeof getToken !== "function") contractError("credential_unavailable", "Bearer credential provider requires a token callback.");
  return Object.freeze({
    kind: "bearer" as const,
    getToken: async (signal?: AbortSignal) => validateBearerToken(await getToken(signal))
  });
}

export function createMemoryBearerCredential(token: string): BearerCredentialProvider {
  const getToken = () => token;
  return createBearerCredentialProvider(getToken);
}

function validateBindingGrant(manifest: ConnectorManifest, value: unknown): ConnectorBindingGrant {
  assertExactKeys(value, ["operations", "pathParameters"], "Connector binding grant");
  const operations = requireStringArray(value.operations, "Granted connector operations", (entry) => requireId(entry, "Granted operation ID"));
  if (operations.length === 0) contractError("invalid_grant", "Connector binding grant requires at least one operation.");
  const grantedOperations = operations.map((operationId) => {
    const operation = manifest.operations.find((candidate) => candidate.id === operationId);
    if (!operation || operation.transport !== "http" || !operation.http) {
      contractError("invalid_grant", `Granted operation ${operationId} is not a declared HTTP operation.`);
    }
    return operation;
  });
  if (!isPlainRecord(value.pathParameters)) contractError("invalid_grant", "Granted path parameters must be a plain object.");
  const requiredParameters = [...new Set(grantedOperations.flatMap((operation) => templatePlaceholders(operation.http!.pathTemplate)))].sort();
  const actualParameters = Object.keys(value.pathParameters).sort();
  if (requiredParameters.length !== actualParameters.length || requiredParameters.some((name, index) => name !== actualParameters[index])) {
    contractError("invalid_grant", "Granted path parameters do not exactly cover operation placeholders.");
  }
  const pathParameters: Record<string, readonly string[]> = {};
  for (const name of requiredParameters) {
    if (!QUERY_PATTERN.test(name)) contractError("invalid_grant", `Granted path parameter ${name} is invalid.`);
    const rawValues = value.pathParameters[name];
    const values = requireStringArray(rawValues, `Granted ${name} values`, (entry) => requireText(entry, `Granted ${name}`, 2048));
    if (values.length === 0 || values.length > 128) {
      contractError("invalid_grant", `Granted path parameter ${name} requires 1 to 128 values.`);
    }
    pathParameters[name] = Object.freeze(values);
  }
  return deepFreeze({ operations, pathParameters });
}

interface ValidatedConnectorRequest extends ConnectorFixtureRequest {
  readonly responseLimit: number;
}

function validateRequest(
  manifest: ConnectorManifest,
  grant: ConnectorBindingGrant,
  request: ConnectorRequest
): ValidatedConnectorRequest {
  if (!isPlainRecord(request)) contractError("invalid_request", "Connector request must be a plain object.");
  assertAllowedKeys(request, ["operationId", "url", "method", "headers", "body", "signal"], "Connector request");
  const operationId = requireId(request.operationId, "Connector request operation ID");
  const operation = manifest.operations.find((candidate) => candidate.id === operationId);
  if (!operation) contractError("undeclared_operation", `Connector operation ${operationId} is not declared.`);
  if (operation.transport !== "http" || !operation.http) {
    contractError("undeclared_operation", `Connector operation ${operationId} does not grant network access.`);
  }
  if (!grant.operations.includes(operationId)) {
    contractError("operation_not_granted", `Connector operation ${operationId} is not granted to this transport.`);
  }
  if (request.method !== operation.http.method) {
    contractError("method_not_allowed", `Connector operation ${operationId} requires ${operation.http.method}.`);
  }

  if (typeof request.url !== "string" || request.url.length > MAX_URL_LENGTH) {
    contractError("invalid_url", "Connector request URL must be a bounded string.");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return contractError("invalid_url", "Connector request URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    contractError("invalid_url", "Connector requests require HTTPS without credentials or fragments.");
  }
  if (!manifest.allowedOrigins.includes(url.origin)) {
    contractError("origin_not_allowed", `Connector origin ${url.origin} is not declared by ${manifest.id}.`);
  }
  const pathParameters = matchPath(operation.http.pathTemplate, url.pathname);
  if (!pathParameters) {
    contractError("path_not_allowed", `Connector path is not declared for operation ${operationId}.`);
  }
  for (const [name, actual] of Object.entries(pathParameters)) {
    if (!grant.pathParameters[name]?.includes(actual)) {
      contractError("resource_not_granted", `Connector path parameter ${name} is outside its bound resource grant.`);
    }
  }
  const queryNames = Array.from(url.searchParams.keys());
  if (new Set(queryNames).size !== queryNames.length) {
    contractError("query_not_allowed", "Connector query parameters cannot be repeated.");
  }
  const unknownQuery = queryNames.find((name) => !operation.http!.allowedQuery.includes(name));
  if (unknownQuery) contractError("query_not_allowed", `Connector query parameter ${unknownQuery} is not declared.`);

  const headers: Record<string, string> = {};
  if (request.headers !== undefined) {
    if (!isPlainRecord(request.headers)) contractError("header_not_allowed", "Connector request headers must be a plain object.");
    for (const [rawName, rawValue] of Object.entries(request.headers)) {
      const name = rawName.toLowerCase();
      if (!HEADER_PATTERN.test(name) || ["authorization", "cookie", "proxy-authorization", "set-cookie"].includes(name)) {
        contractError("header_not_allowed", `Connector request header ${name} cannot be supplied by connector code.`);
      }
      if (!operation.http.allowedRequestHeaders.includes(name)) {
        contractError("header_not_allowed", `Connector request header ${name} is not declared.`);
      }
      if (typeof rawValue !== "string" || containsControlCharacters(rawValue)) {
        contractError("header_not_allowed", `Connector request header ${name} has an invalid value.`);
      }
      if (name in headers) contractError("header_not_allowed", `Connector request header ${name} is duplicated.`);
      headers[name] = rawValue;
    }
  }

  let body: string | undefined;
  if (request.body === undefined && operation.http.requestBody === "required") {
    contractError("body_required", `Connector operation ${operationId} requires a body.`);
  }
  if (request.body !== undefined) {
    if (typeof request.body !== "string") contractError("body_not_allowed", "Connector request body must be a string.");
    if (operation.http.requestBody === "none") contractError("body_not_allowed", `Connector operation ${operationId} does not allow a body.`);
    const bodyBytes = new TextEncoder().encode(request.body).byteLength;
    if (bodyBytes > operation.http.maxRequestBytes) contractError("request_too_large", "Connector request body exceeds its declared limit.");
    const contentType = headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
    if (!contentType || !operation.http.requestContentTypes.includes(contentType)) {
      contractError("content_type_not_allowed", `Connector operation ${operationId} requires a declared request content type.`);
    }
    body = request.body;
  } else if ("content-type" in headers) {
    contractError("content_type_not_allowed", "Connector requests without a body cannot supply content-type.");
  }

  return Object.freeze({
    operation,
    url: url.toString(),
    method: operation.http.method,
    headers: Object.freeze(headers),
    ...(body === undefined ? {} : { body }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    responseLimit: operation.http.maxResponseBytes
  });
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  allowedContentTypes: readonly string[]
) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    contractError("response_too_large", "Connector response exceeds its declared limit.");
  }
  if (response.ok && ![204, 205].includes(response.status)) {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!contentType || !allowedContentTypes.includes(contentType)) {
      contractError("content_type_not_allowed", "Connector response content type is not declared by its operation.");
    }
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      contractError("response_too_large", "Connector response exceeds its declared limit.");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bodyAllowed = ![204, 205, 304].includes(response.status);
  return new Response(bodyAllowed ? bytes : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

type ConnectorSender = (request: ValidatedConnectorRequest) => Promise<Response>;

function createTransport(
  manifest: ConnectorManifest,
  grant: ConnectorBindingGrant,
  sender: ConnectorSender
): ConnectorTransport {
  const connectorId = manifest.id;
  const connectorVersion = manifest.version;
  return Object.freeze({
    connectorId,
    connectorVersion,
    request: async (request: ConnectorRequest) => {
      const validated = validateRequest(manifest, grant, request);
      const response = await sender(validated);
      if (!(response instanceof Response)) contractError("invalid_response", "Connector transport returned an invalid response.");
      return readBoundedResponse(response, validated.responseLimit, validated.operation.http!.responseContentTypes);
    }
  });
}

export class CredentialBroker {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
  }

  bind(
    manifestValue: ConnectorManifest,
    credential: BearerCredentialProvider | undefined,
    grantValue: ConnectorBindingGrant
  ): ConnectorTransport {
    const manifest = validateConnectorManifest(manifestValue);
    if (manifest.auth.kind === "none" && credential !== undefined) {
      contractError("credential_not_allowed", `Connector ${manifest.id} does not accept credentials.`);
    }
    if (manifest.auth.kind === "bearer" && credential?.kind !== "bearer") {
      contractError("credential_required", `Connector ${manifest.id} requires a bearer credential provider.`);
    }
    const grant = validateBindingGrant(manifest, grantValue);
    return createTransport(manifest, grant, async (request) => {
      const headers = new Headers(request.headers);
      if (manifest.auth.kind === "bearer") {
        const token = validateBearerToken(await credential!.getToken(request.signal));
        headers.set("authorization", `Bearer ${token}`);
      }
      return this.fetcher(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
    });
  }
}

export function createConnectorFixtureTransport(
  manifestValue: ConnectorManifest,
  grantValue: ConnectorBindingGrant,
  handlers: ConnectorFixtureHandlers
): ConnectorTransport {
  const manifest = validateConnectorManifest(manifestValue);
  const grant = validateBindingGrant(manifest, grantValue);
  return createTransport(manifest, grant, async (request) => {
    const handler = handlers[request.operation.id];
    if (!handler) contractError("missing_fixture", `No fixture is registered for ${request.operation.id}.`);
    return handler(request);
  });
}

export const LOCAL_SPREADSHEET_MANIFEST = defineConnectorManifest({
  schemaVersion: CONNECTOR_MANIFEST_SCHEMA_VERSION,
  id: "local-spreadsheet",
  label: "Local spreadsheet",
  version: "1.0.0",
  compatibleCore: { minInclusive: "0.16.0", maxExclusive: "1.0.0" },
  auth: { kind: "none" },
  allowedOrigins: [],
  operations: [
    { id: "read-range", effect: "read", transport: "local", retry: "idempotent", precondition: "none", http: null },
    { id: "write-range", effect: "commit", transport: "local", retry: "never", precondition: "recheck", http: null }
  ]
});

export const GOOGLE_SHEETS_MANIFEST = defineConnectorManifest({
  schemaVersion: CONNECTOR_MANIFEST_SCHEMA_VERSION,
  id: "google-sheets",
  label: "Google Sheets",
  version: "1.0.0",
  compatibleCore: { minInclusive: "0.16.0", maxExclusive: "1.0.0" },
  auth: { kind: "bearer", label: "Google OAuth access token" },
  allowedOrigins: ["https://sheets.googleapis.com"],
  operations: [
    {
      id: "read-range",
      effect: "read",
      transport: "http",
      retry: "idempotent",
      precondition: "none",
      http: {
        method: "GET",
        pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
        allowedQuery: ["majorDimension", "valueRenderOption"],
        allowedRequestHeaders: [],
        requestBody: "none",
        requestContentTypes: [],
        responseContentTypes: ["application/json"],
        maxRequestBytes: 0,
        maxResponseBytes: 2 * 1024 * 1024
      }
    },
    {
      id: "write-range",
      effect: "commit",
      transport: "http",
      retry: "never",
      precondition: "recheck",
      http: {
        method: "PUT",
        pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
        allowedQuery: ["valueInputOption"],
        allowedRequestHeaders: ["content-type"],
        requestBody: "required",
        requestContentTypes: ["application/json"],
        responseContentTypes: ["application/json"],
        maxRequestBytes: 2 * 1024 * 1024,
        maxResponseBytes: 256 * 1024
      }
    }
  ]
});
