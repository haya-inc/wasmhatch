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

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
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
    this.bearerToken = options.bearerToken;
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
      signal
    });
    const storedSession = response.headers.get("Mcp-Session-Id");
    if (storedSession) this.sessionId = storedSession;
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw this.describeHttpError(response.status);
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
          response.body.cancel().catch(() => undefined);
          return message as JsonRpcResponse;
        }
      }
      throw new Error("The MCP server closed the stream without answering the request.");
    }
    const parsed: unknown = await response.json();
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (isRecord(message) && message.id === id) return message as JsonRpcResponse;
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
      capabilities: {},
      clientInfo: { name: "WasmHatch", version: "1" }
    }, signal);
    if (!isRecord(result)) throw new Error("The MCP server sent a malformed initialize result.");
    this.negotiatedVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
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
        tools.push({
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object" }
        });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    if (!isRecord(result)) throw new Error("The MCP server sent a malformed tools/call result.");
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const part of result.content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        else if (part.type === "image") parts.push("[image content omitted]");
        else if (part.type === "audio") parts.push("[audio content omitted]");
        else if (part.type === "resource" && isRecord(part.resource) && typeof part.resource.text === "string") {
          parts.push(part.resource.text);
        } else if (part.type === "resource_link" && typeof part.uri === "string") {
          parts.push(`[resource: ${part.uri}]`);
        }
      }
    }
    let content = parts.join("\n");
    if (content.length > MAX_RESULT_CHARS) {
      content = `${content.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
    }
    return { content, isError: result.isError === true };
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
  routes: Map<string, { serverId: string; tool: string }>;
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
  const routes = new Map<string, { serverId: string; tool: string }>();
  for (const tool of tools) {
    const safeTool = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
    let name = `mcp_${serverId}_${safeTool}`.slice(0, MAX_TOOL_NAME_CHARS);
    for (let suffix = 2; routes.has(name); suffix += 1) {
      name = `${name.slice(0, MAX_TOOL_NAME_CHARS - 4)}_${suffix}`;
    }
    const description = `[${serverLabel} via MCP] ${tool.description}`.trim().slice(0, MAX_TOOL_DESCRIPTION_CHARS);
    definitions.push({ name, description, inputSchema: tool.inputSchema });
    routes.set(name, { serverId, tool: tool.name });
  }
  return { definitions, routes };
}
