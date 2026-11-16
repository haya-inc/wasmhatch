/**
 * Minimal MCP client over Streamable HTTP, for the browser.
 *
 * Covers exactly what hatchlings need: `initialize`, `tools/list`, and
 * `tools/call`, against servers that answer each POST with either a JSON
 * body or a short SSE stream (both are legal in Streamable HTTP). Session
 * ids and protocol-version headers are handled; server-initiated requests
 * and subscriptions are not (v1 scope).
 *
 * Credential rules match every other adapter in this codebase: a bearer
 * token lives in memory, goes only to the configured server, and never
 * appears in thrown errors or logs. Tool results are data for the model,
 * never instructions.
 */

import { readSseStream } from "./agent-core/sse";
import type { AgentToolDefinition } from "./agent-core/types";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOOL_PAGES = 10;
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const HEADER_VALUE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const BEARER_TOKEN_PATTERN = /^[\x21-\x7e]{1,16384}$/;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  uiResourceUris?: string[];
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export interface McpContentAnnotations {
  audience?: readonly string[];
  priority?: number;
}

export interface McpResourceContentItem {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpRawContentBlock {
  type: string;
  text?: string;
  uri?: string;
  mimeType?: string;
  resource?: McpResourceContentItem;
  annotations?: McpContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpRawToolResult {
  content: McpRawContentBlock[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError: boolean;
}

export interface McpReadResourceResult {
  contents: McpResourceContentItem[];
  _meta?: Record<string, unknown>;
}

export interface McpConnectionOptions {
  url: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractUiResourceUris(source: Record<string, unknown>): string[] {
  const meta = isRecord(source._meta) ? source._meta : null;
  const ui = meta && isRecord(meta.ui) ? meta.ui : null;
  const raw = ui?.resourceUri;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  return [...new Set(list.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
}

function isUserOnlyAudience(annotations: McpContentAnnotations | undefined): boolean {
  if (!annotations || !Array.isArray(annotations.audience) || annotations.audience.length === 0) {
    return false;
  }
  return annotations.audience.includes("user") && !annotations.audience.includes("assistant");
}

function isUiResourceMime(mimeType: string | undefined, uri: string | undefined): boolean {
  if (typeof uri === "string" && (uri.startsWith("a2ui://") || uri.startsWith("ui://"))) {
    return true;
  }
  if (typeof mimeType !== "string") return false;
  const lower = mimeType.toLowerCase();
  if (lower === "application/a2ui+json") return true;
  const parts = lower.split(";").map((part) => part.trim());
  return parts[0] === "text/html" && parts.includes("profile=mcp-app");
}

export function formatMcpCallResultForAssistant(
  raw: McpRawToolResult,
  options: { stripUserOnlyBlocks?: boolean; uiNote?: string | null } = {}
): McpCallResult {
  const parts: string[] = [];
  for (const part of raw.content) {
    if (options.stripUserOnlyBlocks) {
      if (isUserOnlyAudience(part.annotations)) continue;
      if (part.type === "resource" && isUiResourceMime(part.resource?.mimeType, part.resource?.uri)) continue;
      if (part.type === "resource_link" && isUiResourceMime(part.mimeType, part.uri)) continue;
    }
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image") parts.push("[image content omitted]");
    else if (part.type === "audio") parts.push("[audio content omitted]");
    else if (part.type === "resource" && part.resource && typeof part.resource.text === "string") {
      parts.push(part.resource.text);
    } else if (part.type === "resource_link" && typeof part.uri === "string") {
      parts.push(`[resource: ${part.uri}]`);
    }
  }
  if (options.uiNote) {
    parts.push(options.uiNote);
  }
  let content = parts.join("\n");
  if (content.length > MAX_RESULT_CHARS) {
    content = `${content.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
  }
  return { content, isError: raw.isError };
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 1) return present[0];
  if ("any" in AbortSignal && typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export class McpConnection {
  private readonly url: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private nextRequestId = 1;
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;
  serverName: string | null = null;

  constructor(options: McpConnectionOptions) {
    this.url = options.url;
    const trimmedToken = options.bearerToken?.trim();
    if (trimmedToken && !BEARER_TOKEN_PATTERN.test(trimmedToken)) {
      throw new Error("The MCP access token contains invalid characters.");
    }
    this.bearerToken = trimmedToken || undefined;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (this.negotiatedVersion) headers["MCP-Protocol-Version"] = this.negotiatedVersion;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private describeHttpError(status: number): Error {
    const origin = new URL(this.url).origin;
    if (status === 401 || status === 403) {
      return new Error(`The MCP server at ${origin} rejected authentication (HTTP ${status}). Check its access token.`);
    }
    if (status === 404 && this.sessionId) {
      this.sessionId = null;
      return new Error(`The MCP session at ${origin} expired. Reconnect the server and try again.`);
    }
    return new Error(`The MCP server at ${origin} answered HTTP ${status}.`);
  }

  /** Sends one JSON-RPC message; returns the matching response, or null for notifications. */
  private async send(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { notification?: boolean; signal?: AbortSignal } = {}
  ): Promise<JsonRpcResponse | null> {
    const id = options.notification ? undefined : this.nextRequestId++;
    const signal = combineSignals([options.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
      credentials: "omit",
      redirect: "error",
      signal
    });
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw this.describeHttpError(response.status);
    }
    const storedSession = response.headers.get("Mcp-Session-Id")?.trim();
    if (storedSession && HEADER_VALUE_PATTERN.test(storedSession)) {
      this.sessionId = storedSession;
    }
    if (options.notification || response.status === 202 || response.status === 204) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (!response.body) throw new Error("The MCP server sent an empty stream.");
      for await (const event of readSseStream(response.body, signal)) {
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          continue;
        }
        // Server-initiated requests and notifications are out of v1 scope; skip them.
        if (isRecord(message) && message.id === id && ("result" in message || "error" in message)) {
          return message as JsonRpcResponse;
        }
      }
      throw new Error("The MCP server closed the stream without answering the request.");
    }
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("The MCP server response exceeded the 4 MB limit.");
    }
    const rawText = await response.text();
    if (rawText.length > MAX_JSON_RESPONSE_BYTES) {
      throw new Error("The MCP server response exceeded the 4 MB limit.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error("The MCP server answered with unreadable JSON.");
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (isRecord(message) && message.id === id && ("result" in message || "error" in message)) {
        return message as JsonRpcResponse;
      }
    }
    throw new Error("The MCP server answered with a response for a different request.");
  }

  /** Sends a request and unwraps its result, translating JSON-RPC errors. */
  private async request(method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(method, params, { signal });
    if (!response) throw new Error("The MCP server did not answer the request.");
    if (response.error) {
      const message = typeof response.error.message === "string" ? response.error.message : "unknown error";
      throw new Error(`MCP ${method} failed: ${message}`);
    }
    return response.result;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        a2ui: {
          version: "1.0",
          acceptsInlineCatalogs: false,
          mimeTypes: ["application/a2ui+json", "text/html;profile=mcp-app"],
          supportedCatalogIds: [
            "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
            "https://a2ui.org/specification/v1_0/catalogs/vegachart/catalog.json",
            "https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json",
            "https://a2ui.org/specification/v0_9/basic_catalog.json",
            "wasmhatch:tabular:v1",
            "wasmhatch:workspace:v1",
            "wasmhatch:connectors:v1"
          ]
        }
      },
      clientInfo: { name: "WasmHatch", version: "1" }
    }, signal);
    if (!isRecord(result)) throw new Error("The MCP server sent a malformed initialize result.");
    const candidateVersion = typeof result.protocolVersion === "string" ? result.protocolVersion.trim() : "";
    this.negotiatedVersion = candidateVersion && HEADER_VALUE_PATTERN.test(candidateVersion)
      ? candidateVersion
      : MCP_PROTOCOL_VERSION;
    const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : null;
    this.serverName = serverInfo && typeof serverInfo.name === "string" ? serverInfo.name : null;
    await this.send("notifications/initialized", undefined, { notification: true, signal });
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new Error("The MCP server sent a malformed tools/list result.");
      }
      for (const entry of result.tools) {
        if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) continue;
        const annotations = isRecord(entry.annotations) ? entry.annotations : null;
        const uiResourceUris = extractUiResourceUris(entry);
        tools.push({
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object" },
          ...(annotations?.readOnlyHint === true ? { readOnlyHint: true } : {}),
          ...(uiResourceUris.length > 0 ? { uiResourceUris } : {})
        });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const result = await this.request("resources/read", { uri }, signal);
    if (!isRecord(result) || !Array.isArray(result.contents)) {
      throw new Error("The MCP server sent a malformed resources/read result.");
    }
    const contents: McpResourceContentItem[] = [];
    for (const item of result.contents) {
      if (!isRecord(item)) continue;
      contents.push({
        ...(typeof item.uri === "string" ? { uri: item.uri } : {}),
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
        ...(isRecord(item._meta) ? { _meta: item._meta } : {})
      });
    }
    return {
      contents,
      ...(isRecord(result._meta) ? { _meta: result._meta } : {})
    };
  }

  async callToolRaw(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpRawToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    if (!isRecord(result)) throw new Error("The MCP server sent a malformed tools/call result.");
    const content: McpRawContentBlock[] = [];
    if (Array.isArray(result.content)) {
      for (const part of result.content) {
        if (!isRecord(part) || typeof part.type !== "string") continue;
        const annotations = isRecord(part.annotations) ? part.annotations : null;
        const parsedAnnotations: McpContentAnnotations | undefined = annotations
          ? {
              ...(Array.isArray(annotations.audience)
                ? { audience: annotations.audience.filter((a): a is string => typeof a === "string") }
                : {}),
              ...(typeof annotations.priority === "number" ? { priority: annotations.priority } : {})
            }
          : undefined;
        const resource = isRecord(part.resource) ? part.resource : null;
        content.push({
          type: part.type,
          ...(typeof part.text === "string" ? { text: part.text } : {}),
          ...(typeof part.uri === "string" ? { uri: part.uri } : {}),
          ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
          ...(resource
            ? {
                resource: {
                  ...(typeof resource.uri === "string" ? { uri: resource.uri } : {}),
                  ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
                  ...(typeof resource.text === "string" ? { text: resource.text } : {}),
                  ...(typeof resource.blob === "string" ? { blob: resource.blob } : {}),
                  ...(isRecord(resource._meta) ? { _meta: resource._meta } : {})
                }
              }
            : {}),
          ...(parsedAnnotations ? { annotations: parsedAnnotations } : {}),
          ...(isRecord(part._meta) ? { _meta: part._meta } : {})
        });
      }
    }
    return {
      content,
      ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
      ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
      isError: result.isError === true
    };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const raw = await this.callToolRaw(name, args, signal);
    return formatMcpCallResultForAssistant(raw);
  }

  /** Best-effort session teardown; a server without sessions just 405s. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000)
      });
    } catch {
      /* closing is courtesy; the server times the session out on its own */
    }
    this.sessionId = null;
  }
}

export interface McpToolset {
  definitions: AgentToolDefinition[];
  /** Namespaced tool name → the server id and original tool name to call. */
  routes: Map<string, { serverId: string; tool: string; readOnly?: boolean }>;
}

const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_DESCRIPTION_CHARS = 600;

/**
 * Surfaces a server's tools to the agent loop as `mcp_<server>_<tool>`,
 * with provider-safe names and collision-proof routing back to the
 * original tool name.
 */
export function buildMcpToolset(serverId: string, serverLabel: string, tools: readonly McpToolInfo[]): McpToolset {
  const definitions: AgentToolDefinition[] = [];
  const routes = new Map<string, { serverId: string; tool: string; readOnly?: boolean }>();
  for (const tool of tools) {
    const safeTool = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const baseName = `mcp_${serverId}_${safeTool}`;
    let name = baseName.slice(0, MAX_TOOL_NAME_CHARS);
    for (let suffix = 2; routes.has(name); suffix += 1) {
      const suffixPart = `_${suffix}`;
      name = `${baseName.slice(0, Math.max(1, MAX_TOOL_NAME_CHARS - suffixPart.length))}${suffixPart}`;
    }
    const description = `[${serverLabel} via MCP] ${tool.description}`.trim().slice(0, MAX_TOOL_DESCRIPTION_CHARS);
    definitions.push({ name, description, inputSchema: tool.inputSchema });
    routes.set(name, {
      serverId,
      tool: tool.name,
      ...(tool.readOnlyHint ? { readOnly: true } : {})
    });
  }
  return { definitions, routes };
}
