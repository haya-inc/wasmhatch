import "./dom-polyfill-guard";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import type { A2uiMessage } from "@a2ui/web_core/v0_9";
import {
  A2uiExpressionError,
  AccessibilityAttributesSchema,
  Catalog,
  createFunctionImplementation,
  DataContext,
  DynamicStringSchema,
  DynamicValueSchema,
  spec,
  type ComponentApi,
  type FunctionApi,
  type FunctionCall,
  type FunctionImplementation,
  type MessageProcessor
} from "@a2ui/web_core/v1_0";
// A2UI uses the security-patched v3 compatibility API from Zod 4.
import { z } from "zod/v3";
import type {
  McpRawContentBlock,
  McpRawToolResult,
  McpReadResourceResult
} from "../mcp-client";
import type { McpConnectedServer } from "../mcp-registry";
import { searchJmesPath } from "./jmespath";
import { A2uiInputLimitError, assertA2uiInput, parseA2uiJson } from "./input-limits";
import {
  DEFAULT_MCP_APP_HEIGHT,
  McpAppHostBridge,
  resolveMcpSandboxConfig,
  type AllowedFunctionConfig,
  type McpAppCspConfig,
  type McpAppPermissionsConfig
} from "./mcp-app-bridge";
import { useA2uiSurfaceRpc } from "./rpc-functions";

export const MCP_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json";
export const A2UI_MIME_TYPE = "application/a2ui+json";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const URL_ENCODED_PREFIX = "url_encoded:";

const MAX_CACHED_PATTERNS = 100;
const MAX_CACHED_RESOURCES = 100;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const compiledRegexCache = new Map<string, RegExp>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeHtmlContent(htmlContent: string): string {
  if (htmlContent.startsWith(URL_ENCODED_PREFIX)) {
    try {
      return decodeURIComponent(htmlContent.slice(URL_ENCODED_PREFIX.length));
    } catch {
      return "";
    }
  }
  return htmlContent;
}

const MAX_REGEX_LENGTH = 512;

/**
 * Validates that `source` belongs to the portable A2UI regex dialect and contains
 * no catastrophic backtracking (ReDoS) constructs such as nested quantifiers or backreferences.
 */
export function analyzeA2uiRegex(
  source: string
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (source.length > MAX_REGEX_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      detail: `Pattern exceeds ${MAX_REGEX_LENGTH} characters.`
    };
  }

  let inCharClass = false;
  // Stack tracks whether each open group contains an unbounded/repeating quantifier inside it.
  const groupHasQuantifier: boolean[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) {
        return { ok: false, reason: "invalid_escape", detail: "Trailing backslash." };
      }
      if (!inCharClass && ((next >= "1" && next <= "9") || next === "k")) {
        return {
          ok: false,
          reason: "unsupported_backreference",
          detail: "Backreferences are outside the portable A2UI regex dialect."
        };
      }
      i += 1;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      continue;
    }
    if (ch === "]" && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;

    if (ch === "(") {
      if (source[i + 1] === "?" && (source[i + 2] === "<" && (source[i + 3] === "=" || source[i + 3] === "!"))) {
        return {
          ok: false,
          reason: "unsupported_lookbehind",
          detail: "Lookbehind assertions are outside the portable A2UI regex dialect."
        };
      }
      groupHasQuantifier.push(false);
      continue;
    }

    if (ch === ")") {
      const innerHadQuantifier = groupHasQuantifier.pop() ?? false;
      const after = source[i + 1];
      const groupIsRepeated =
        after === "+" ||
        after === "*" ||
        (after === "{" && /^\{(\d+,\d*|[2-9]\d*|\d{2,})\}/.test(source.slice(i + 1)));
      if (innerHadQuantifier && groupIsRepeated) {
        return {
          ok: false,
          reason: "catastrophic_backtracking",
          detail: "Nested repeating quantifiers can trigger exponential ReDoS backtracking."
        };
      }
      if (innerHadQuantifier && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }

    if (
      ch === "+" ||
      ch === "*" ||
      (ch === "{" && /^\{(\d+,\d*|[2-9]\d*|\d{2,})\}/.test(source.slice(i)))
    ) {
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
    }
  }

  return { ok: true };
}

export function compileSafeRegex(source: string, functionName: string): RegExp {
  const cached = compiledRegexCache.get(source);
  if (cached) {
    compiledRegexCache.delete(source);
    compiledRegexCache.set(source, cached);
    return cached;
  }
  const analysis = analyzeA2uiRegex(source);
  if (!analysis.ok) {
    throw new A2uiExpressionError(
      `${functionName} rejected the pattern '${source}' (${analysis.reason}): ${analysis.detail}`,
      functionName
    );
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, "u");
  } catch (error) {
    throw new A2uiExpressionError(
      `${functionName} could not compile the pattern '${source}': ${error instanceof Error ? error.message : String(error)}`,
      functionName,
      error
    );
  }
  if (compiledRegexCache.size >= MAX_CACHED_PATTERNS) {
    const oldest = compiledRegexCache.keys().next().value;
    if (oldest !== undefined) compiledRegexCache.delete(oldest);
  }
  compiledRegexCache.set(source, compiled);
  return compiled;
}

function mapTextValue<T>(value: unknown, fn: (item: string) => T): T | T[] {
  const asText = (item: unknown) => String(item ?? "");
  return Array.isArray(value) ? value.map((item) => fn(asText(item))) : fn(asText(value));
}

export interface McpToolDataPayload {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolResult: Record<string, unknown>;
  readonly structuredContent?: Record<string, unknown>;
  readonly text?: string;
  readonly json?: unknown;
  readonly resourceUri?: string;
  readonly html?: string;
  readonly csp?: McpAppCspConfig;
  readonly permissions?: McpAppPermissionsConfig;
}

export interface McpAppResourcePayload extends McpToolDataPayload {
  readonly resourceUri: string;
  readonly html: string;
}

type DecodedMcpAppResource = Pick<
  McpAppResourcePayload,
  "resourceUri" | "html" | "csp" | "permissions"
>;

interface DecodedUiResource {
  readonly a2uiMessages: A2uiMessage[];
  readonly mcpAppResources: DecodedMcpAppResource[];
}

function parseJsonContainer(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = parseA2uiJson(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch (error) {
    if (error instanceof A2uiInputLimitError) throw error;
    return undefined;
  }
}

export function extractToolResultContent(
  result: Pick<McpRawToolResult, "content" | "structuredContent">
): Pick<McpToolDataPayload, "structuredContent" | "text" | "json"> {
  const blocks = (result.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
  const structuredContent = isPlainRecord(result.structuredContent)
    ? result.structuredContent
    : undefined;
  const text = blocks.length > 0 ? blocks.join("\n") : undefined;
  let json = text === undefined ? undefined : parseJsonContainer(text);
  if (json === undefined && blocks.length >= 2) {
    const parsedBlocks = blocks.map(parseJsonContainer).filter((p) => p !== undefined);
    if (parsedBlocks.length >= 1) {
      json = parsedBlocks;
    }
  }
  return {
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(json !== undefined ? { json } : {})
  };
}

export function readUiResourceUris(source: { _meta?: unknown } | undefined): string[] {
  const meta = source && isPlainRecord(source._meta) ? source._meta : null;
  const ui = meta && isPlainRecord(meta.ui) ? meta.ui : null;
  const declared = ui?.resourceUri;
  const uris = Array.isArray(declared) ? declared : declared !== undefined ? [declared] : [];
  return [...new Set(uris.filter((u): u is string => typeof u === "string" && u.trim() !== ""))];
}

function isMcpAppMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== "string") return false;
  const [type, ...params] = mimeType
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  return type === "text/html" && params.includes("profile=mcp-app");
}

function isUiSchemeUri(uri: unknown): boolean {
  return typeof uri === "string" && uri.startsWith("ui://");
}

function decodeBase64Utf8(blob: string): string {
  const binary = atob(blob);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function readResourceItemHtml(item: { text?: unknown; blob?: unknown }): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.blob === "string") {
    try {
      return decodeBase64Utf8(item.blob);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizePermissionsMeta(raw: unknown): McpAppPermissionsConfig | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return {
    ...(raw.camera ? { camera: true } : {}),
    ...(raw.microphone ? { microphone: true } : {}),
    ...(raw.geolocation ? { geolocation: true } : {}),
    ...(raw.clipboardWrite ? { clipboardWrite: true } : {})
  };
}

function normalizeCspMeta(raw: unknown): McpAppCspConfig | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  return {
    ...(strArr(raw.connectDomains) ? { connectDomains: strArr(raw.connectDomains) } : {}),
    ...(strArr(raw.resourceDomains) ? { resourceDomains: strArr(raw.resourceDomains) } : {}),
    ...(strArr(raw.frameDomains) ? { frameDomains: strArr(raw.frameDomains) } : {})
  };
}

function toDecodedMcpAppResource(
  resourceUri: string,
  html: string,
  uiMeta: Record<string, unknown> | undefined
): DecodedMcpAppResource {
  const csp = normalizeCspMeta(uiMeta?.csp);
  const permissions = normalizePermissionsMeta(uiMeta?.permissions);
  return {
    resourceUri,
    html,
    ...(csp ? { csp } : {}),
    ...(permissions ? { permissions } : {})
  };
}

export function extractA2uiMessages(
  content: readonly McpRawContentBlock[] | undefined
): A2uiMessage[] {
  const messages: A2uiMessage[] = [];
  for (const block of content ?? []) {
    if (block?.type !== "resource" || block.resource?.mimeType !== A2UI_MIME_TYPE) continue;
    const { text, uri } = block.resource;
    if (typeof text !== "string") continue;
    let parsed: A2uiMessage | A2uiMessage[];
    try {
      parsed = parseA2uiJson(text) as A2uiMessage | A2uiMessage[];
    } catch (error) {
      if (error instanceof A2uiInputLimitError) throw error;
      throw new Error(`Resource ${uri ?? "(inline)"} declares ${A2UI_MIME_TYPE} with invalid JSON.`);
    }
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    assertA2uiInput(messages);
  }
  return messages;
}

export function parseA2uiMessagesFromResource(
  resource: McpReadResourceResult | undefined,
  uri: string
): A2uiMessage[] {
  const out: A2uiMessage[] = [];
  for (const item of resource?.contents ?? []) {
    if (item.mimeType !== A2UI_MIME_TYPE && !(typeof item.uri === "string" && item.uri.startsWith("a2ui://") && !item.mimeType)) {
      continue;
    }
    if (typeof item.text !== "string") continue;
    let parsed: A2uiMessage | A2uiMessage[];
    try {
      parsed = parseA2uiJson(item.text) as A2uiMessage | A2uiMessage[];
    } catch (error) {
      if (error instanceof A2uiInputLimitError) throw error;
      throw new Error(`Resource ${uri} declares ${A2UI_MIME_TYPE} with invalid JSON.`);
    }
    out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    assertA2uiInput(out);
  }
  return out;
}

export function extractMcpAppResourceLinkUris(
  content: readonly McpRawContentBlock[] | undefined
): string[] {
  const uris: string[] = [];
  for (const block of content ?? []) {
    if (block?.type !== "resource_link" || typeof block.uri !== "string" || !block.uri) continue;
    if (block.mimeType === A2UI_MIME_TYPE) continue;
    if (isMcpAppMimeType(block.mimeType) || isUiSchemeUri(block.uri) || block.uri.startsWith("a2ui://")) {
      uris.push(block.uri);
    }
  }
  return [...new Set(uris)];
}

export function extractInlineMcpAppResources(
  content: readonly McpRawContentBlock[] | undefined
): DecodedMcpAppResource[] {
  const out: DecodedMcpAppResource[] = [];
  for (const block of content ?? []) {
    if (block?.type !== "resource" || !block.resource) continue;
    const { uri, mimeType } = block.resource;
    if (mimeType === A2UI_MIME_TYPE) continue;
    if (!isMcpAppMimeType(mimeType) && !isUiSchemeUri(uri)) continue;
    const html = readResourceItemHtml(block.resource);
    if (html === undefined) continue;
    const resUi = isPlainRecord(block.resource._meta?.ui)
      ? (block.resource._meta!.ui as Record<string, unknown>)
      : isPlainRecord(block._meta?.ui)
        ? (block._meta!.ui as Record<string, unknown>)
        : undefined;
    out.push(toDecodedMcpAppResource(uri && uri.trim() ? uri : "ui://inline", html, resUi));
  }
  return out;
}

export function parseMcpAppResourcesFromResource(
  resource: McpReadResourceResult | undefined,
  uri: string
): DecodedMcpAppResource[] {
  const out: DecodedMcpAppResource[] = [];
  const topUi = isPlainRecord(resource?._meta?.ui)
    ? (resource!._meta!.ui as Record<string, unknown>)
    : undefined;
  for (const item of resource?.contents ?? []) {
    if (item.mimeType === A2UI_MIME_TYPE) continue;
    const resolvedUri = item.uri && item.uri.trim() ? item.uri : uri;
    if (!isMcpAppMimeType(item.mimeType) && !isUiSchemeUri(resolvedUri)) continue;
    const html = readResourceItemHtml(item);
    if (html === undefined) continue;
    const itemUi = isPlainRecord(item._meta?.ui)
      ? (item._meta!.ui as Record<string, unknown>)
      : topUi;
    out.push(toDecodedMcpAppResource(resolvedUri, html, itemUi));
  }
  return out;
}

const V09_TO_V10_CATALOG_MAP: Record<string, string> = {
  "https://a2ui.org/specification/v0_9/basic_catalog.json":
    "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
  "https://a2ui.org/specification/v0_9/catalogs/mcp/catalog.json": MCP_CATALOG_ID
};

function ensureMessageVersion(message: A2uiMessage, defaultVersion = "1.0"): A2uiMessage {
  const raw = message as unknown;
  if (!isPlainRecord(raw)) return message;
  const ver = typeof raw.version === "string" ? raw.version : "";
  const normalizedVersion =
    !ver || ver === "v0.9" || ver === "0.9" || ver === "v0.9.1" || ver === "0.9.1" || ver === "v1.0"
      ? defaultVersion
      : ver;
  let createSurface = raw.createSurface;
  if (isPlainRecord(createSurface) && typeof createSurface.catalogId === "string") {
    const mapped = V09_TO_V10_CATALOG_MAP[createSurface.catalogId];
    if (mapped) {
      createSurface = { ...createSurface, catalogId: mapped };
    }
  }
  return {
    ...raw,
    version: normalizedVersion,
    ...(createSurface !== undefined ? { createSurface } : {})
  } as unknown as A2uiMessage;
}

function createsExistingSurface(
  messages: readonly A2uiMessage[],
  processor: MessageProcessor<ReactCatalogComponent>
): boolean {
  return messages.some((msg) => {
    const rec = msg as unknown;
    if (!isPlainRecord(rec) || !isPlainRecord(rec.createSurface)) return false;
    const surfaceId = rec.createSurface.surfaceId;
    return typeof surfaceId === "string" && Boolean(processor.model.getSurface(surfaceId));
  });
}

export interface WasmhatchMcpCatalogBridge {
  readonly canUseMcp: () => boolean;
  readonly canUseArtifacts: () => boolean;
  readonly getLocale: () => string;
  readonly getProcessor: () => MessageProcessor<ReactCatalogComponent>;
  readonly getActiveMcpServers: () => readonly McpConnectedServer[];
  readonly gateMcpToolCall?: (
    toolLabel: string,
    args: Record<string, unknown>,
    readOnly: boolean,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly onMcpAppResource?: (
    payload: McpAppResourcePayload,
    surfaceId?: string
  ) => void;
}

export class McpUiResourceCoordinator {
  private readonly decodedByServer = new Map<string, Map<string, DecodedUiResource>>();

  async readUiResource(
    server: McpConnectedServer,
    uri: string,
    signal?: AbortSignal
  ): Promise<DecodedUiResource> {
    const cacheKey = `${server.server.id}::${server.url}`;
    let serverCache = this.decodedByServer.get(cacheKey);
    if (!serverCache) {
      serverCache = new Map();
      this.decodedByServer.set(cacheKey, serverCache);
    }
    const existing = serverCache.get(uri);
    if (existing) {
      serverCache.delete(uri);
      serverCache.set(uri, existing);
      return existing;
    }
    if (!server.connection.readResource) {
      return { a2uiMessages: [], mcpAppResources: [] };
    }
    const resource = await server.connection.readResource(uri, signal);
    const decoded: DecodedUiResource = {
      a2uiMessages: parseA2uiMessagesFromResource(resource, uri),
      mcpAppResources: parseMcpAppResourcesFromResource(resource, uri)
    };
    if (serverCache.size >= MAX_CACHED_RESOURCES) {
      const oldest = serverCache.keys().next().value;
      if (oldest !== undefined) serverCache.delete(oldest);
    }
    serverCache.set(uri, decoded);
    return decoded;
  }

  async processToolResultResources(params: {
    server: McpConnectedServer;
    toolName: string;
    toolArgs: Record<string, unknown>;
    rawResult: McpRawToolResult;
    processor: MessageProcessor<ReactCatalogComponent>;
    onMcpAppResource?: (payload: McpAppResourcePayload) => void;
    signal?: AbortSignal;
  }): Promise<{
    payload: McpToolDataPayload;
    renderedSurfaceIds: string[];
    renderedMcpApps: McpAppResourcePayload[];
  }> {
    const { server, toolName, toolArgs, rawResult, processor, onMcpAppResource, signal } = params;
    assertA2uiInput(rawResult);
    assertA2uiInput(toolArgs);
    const baseData: McpToolDataPayload = {
      toolName,
      toolInput: toolArgs,
      toolResult: rawResult as unknown as Record<string, unknown>,
      ...extractToolResultContent(rawResult)
    };

    const renderedSurfaceIds = new Set<string>();
    const appPayloads: McpAppResourcePayload[] = [];

    const recordProcessedMessages = (messages: readonly A2uiMessage[]) => {
      assertA2uiInput(messages);
      const versioned = messages.map((m) => ensureMessageVersion(m, "1.0"));
      for (const m of versioned) {
        const rec = m as unknown;
        if (isPlainRecord(rec)) {
          for (const key of ["createSurface", "updateComponents", "updateDataModel"]) {
            const inner = rec[key];
            if (isPlainRecord(inner) && typeof inner.surfaceId === "string") {
              renderedSurfaceIds.add(inner.surfaceId);
            }
          }
        }
      }
      processor.processMessages(versioned);
    };

    const declaredTool = server.tools?.find((entry) => entry.name === toolName);
    const declaredUris = declaredTool?.uiResourceUris ?? [];
    const resultUris = readUiResourceUris(rawResult);
    const linkUris = extractMcpAppResourceLinkUris(rawResult.content);
    const baseUris = resultUris.length > 0 ? resultUris : declaredUris;
    const uris = [...new Set([...baseUris, ...linkUris])];

    for (const uri of uris) {
      const decoded = await this.readUiResource(server, uri, signal);
      if (decoded.a2uiMessages.length > 0 && !createsExistingSurface(decoded.a2uiMessages, processor)) {
        recordProcessedMessages(decoded.a2uiMessages);
      }
      for (const appRes of decoded.mcpAppResources) {
        appPayloads.push({ ...baseData, ...appRes });
      }
    }

    const inlineMessages = extractA2uiMessages(rawResult.content);
    if (inlineMessages.length > 0) {
      recordProcessedMessages(inlineMessages);
    }

    for (const inlineApp of extractInlineMcpAppResources(rawResult.content)) {
      appPayloads.push({ ...baseData, ...inlineApp });
    }

    const finalPayload: McpToolDataPayload = appPayloads.at(-1) ?? baseData;
    for (const appPayload of appPayloads) {
      onMcpAppResource?.(appPayload);
    }

    return {
      payload: finalPayload,
      renderedSurfaceIds: [...renderedSurfaceIds],
      renderedMcpApps: appPayloads
    };
  }

  clear(): void {
    this.decodedByServer.clear();
  }
}

export function resolveMcpServerTool(
  servers: readonly McpConnectedServer[],
  requestedName: string,
  requestedServer?: string
): { server: McpConnectedServer; toolName: string; namespacedName: string; readOnly: boolean } | null {
  const trimmed = requestedName.trim();
  if (!trimmed) return null;

  for (const srv of servers) {
    if (requestedServer && srv.server.id !== requestedServer && srv.server.label !== requestedServer) {
      continue;
    }
    // 1. Exact match on namespaced `mcp_<server>_<tool>` route
    const namespaced = srv.toolset.routes.get(trimmed);
    if (namespaced) {
      return {
        server: srv,
        toolName: namespaced.tool,
        namespacedName: trimmed,
        readOnly: Boolean(namespaced.readOnly)
      };
    }
    // 2. Match `<serverId>/<toolName>` or `<serverId>:<toolName>`
    for (const sep of ["/", ":"]) {
      const prefix = `${srv.server.id}${sep}`;
      if (trimmed.startsWith(prefix)) {
        const sub = trimmed.slice(prefix.length);
        for (const [nsName, route] of srv.toolset.routes.entries()) {
          if (route.tool === sub) {
            return {
              server: srv,
              toolName: route.tool,
              namespacedName: nsName,
              readOnly: Boolean(route.readOnly)
            };
          }
        }
      }
    }
    // 3. Match raw MCP tool name directly
    for (const [nsName, route] of srv.toolset.routes.entries()) {
      if (route.tool === trimmed) {
        return {
          server: srv,
          toolName: route.tool,
          namespacedName: nsName,
          readOnly: Boolean(route.readOnly)
        };
      }
    }
  }
  return null;
}

const McpAppCspSchema = z
  .object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
    baseUriDomains: z.array(z.string()).optional()
  })
  .strict();

const PermissionFlagSchema = z.union([z.boolean(), z.record(z.unknown())]);

const McpAppPermissionsSchema = z
  .object({
    camera: PermissionFlagSchema.optional(),
    microphone: PermissionFlagSchema.optional(),
    geolocation: PermissionFlagSchema.optional(),
    clipboardWrite: PermissionFlagSchema.optional()
  })
  .strict();

export const McpAppApi = {
  name: "McpApp",
  schema: spec(
    z
      .object({
        accessibility: AccessibilityAttributesSchema.optional(),
        htmlContent: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Sandboxed MCP App HTML bundle (`url_encoded:` prefix is automatically decoded)."
        ),
        title: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Accessible title of the embedded MCP App."
        ).optional(),
        resourceUri: DynamicStringSchema.describe(
          "REF:#/$defs/DynamicString|Originating `ui://` resource URI."
        ).optional(),
        toolInput: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Optional originating MCP tool input arguments."
        ).optional(),
        toolResult: DynamicValueSchema.describe(
          "REF:#/$defs/DynamicValue|Optional originating MCP tool result payload."
        ).optional(),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe("Explicit allowlist of MCP tool names the sandboxed guest may call."),
        allowedFunctions: z
          .union([z.record(z.unknown()), z.array(z.unknown())])
          .optional()
          .describe("Explicit allowlist of host catalog functions and JSON Schemas."),
        data: z
          .object({
            paths: z.union([z.record(z.string()), z.array(z.string())])
          })
          .optional()
          .describe("Two-way bound surface DataModel paths exposed to the MCP App."),
        csp: McpAppCspSchema.optional(),
        permissions: McpAppPermissionsSchema.optional()
      })
      .describe(
        "Double-iframe sandboxed MCP App (`text/html;profile=mcp-app`) with per-resource CSP, strict allowlists, and two-way DataModel binding."
      )
      .strict(),
    { mixins: [], required: ["htmlContent"] }
  )
} satisfies ComponentApi;

function isArgumentsFunctionCall(value: unknown): value is FunctionCall {
  if (!isPlainRecord(value)) return false;
  const callKey = "@call" in value ? "@call" : "call" in value ? "call" : null;
  if (!callKey || typeof value[callKey] !== "string") return false;
  return Object.keys(value).every(
    (k) => k === "@call" || k === "call" || k === "args" || k === "returnType"
  );
}

function resolveDynamicArgsRecord(
  raw: unknown,
  context: DataContext
): unknown {
  if (isArgumentsFunctionCall(raw)) {
    return context.resolveDynamicValue(raw as never);
  }
  if (!isPlainRecord(raw)) return raw;
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_SEGMENTS.has(k)) continue;
    resolved[k] = context.resolveDynamicValue(v as never);
  }
  return resolved;
}

export const CallMcpToolApi = {
  name: "callMcpTool" as const,
  returnType: "any" as const,
  allowedCallers: "rendererOrAgent" as const,
  description:
    "Invokes a tool on a connected Model Context Protocol (MCP) server, processes any returned `a2ui://` or `ui://` UI resources, optionally writes the latest result to `targetDataPath`, and returns the `McpToolDataPayload`.",
  schema: spec(
    z.object({
      name: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Name of the MCP tool to invoke."
      ),
      arguments: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Arguments object (or function call returning an object) passed to the MCP tool."
      ).optional(),
      targetDataPath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional JSON Pointer on the surface DataModel updated with the latest result."
      ).optional(),
      server: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Optional MCP server id when disambiguating identically named tools."
      ).optional()
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const TransformDataApi = {
  name: "transformData" as const,
  returnType: "any" as const,
  allowedCallers: "rendererOrAgent" as const,
  description:
    "Evaluates a standard JMESPath expression against `data` with zero network or LLM round-trips.",
  schema: spec(
    z.object({
      jmespath: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Standard JMESPath expression."
      ),
      data: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Input value to evaluate the JMESPath expression against."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const UpdateDataModelApi = {
  name: "updateDataModel" as const,
  returnType: "any" as const,
  allowedCallers: "rendererOrAgent" as const,
  description: "Atomically writes multiple path-value pairs into the surface DataModel.",
  schema: spec(
    z.object({
      updates: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|Object mapping JSON Pointer paths to values."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const SplitApi = {
  name: "split" as const,
  returnType: "any" as const,
  allowedCallers: "rendererOrAgent" as const,
  description: "Splits a string (or array of strings) using a literal separator.",
  schema: spec(
    z.object({
      value: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|String or array of strings to split."
      ),
      separator: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Delimiter string (empty string splits by Unicode code points)."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

export const RegexCaptureApi = {
  name: "regexCapture" as const,
  returnType: "any" as const,
  allowedCallers: "rendererOrAgent" as const,
  description:
    "Extracts capture groups from the first regular expression match in the safe A2UI regex dialect.",
  schema: spec(
    z.object({
      value: DynamicValueSchema.describe(
        "REF:#/$defs/DynamicValue|String or array of strings to match."
      ),
      pattern: DynamicStringSchema.describe(
        "REF:#/$defs/DynamicString|Regular expression in the A2UI Unicode regex dialect."
      )
    }),
    { closure: "unevaluatedProperties" }
  )
} satisfies FunctionApi;

function validateUpdatePath(path: string): void {
  if (path === "") {
    throw new A2uiExpressionError(
      "updateDataModel rejected an empty key: every key must be a data model path.",
      "updateDataModel"
    );
  }
  for (const segment of path.split("/")) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new A2uiExpressionError(
        `updateDataModel rejected the key '${path}': the segment '${segment}' is not allowed.`,
        "updateDataModel"
      );
    }
  }
}

export function createWasmhatchMcpCatalog(
  host: WasmhatchMcpCatalogBridge,
  coordinator = new McpUiResourceCoordinator()
): Catalog<ReactCatalogComponent> {
  const latestCallByPath = new WeakMap<object, Map<string, number>>();
  let callSequence = 0;

  const startCall = (dataModel: object, resolvedPath: string): (() => boolean) => {
    let map = latestCallByPath.get(dataModel);
    if (!map) {
      map = new Map<string, number>();
      latestCallByPath.set(dataModel, map);
    }
    const seq = ++callSequence;
    map.set(resolvedPath, seq);
    return () => map!.get(resolvedPath) === seq;
  };

  const executeDirectMcpTool = async (
    requestedName: string,
    resolvedArgs: Record<string, unknown>,
    requestedServer?: string,
    surfaceId?: string,
    signal?: AbortSignal
  ): Promise<McpToolDataPayload> => {
    if (!host.canUseMcp()) {
      throw new A2uiExpressionError(
        `Cannot execute MCP tool '${requestedName}': capability 'mcp' is disabled for this hatchling.`,
        "callMcpTool"
      );
    }
    const servers = host.getActiveMcpServers();
    const resolved = resolveMcpServerTool(servers, requestedName, requestedServer);
    if (!resolved) {
      throw new A2uiExpressionError(
        `MCP client for tool '${requestedName}' could not be resolved. Connect the MCP server first.`,
        "callMcpTool"
      );
    }

    if (!resolved.readOnly && host.gateMcpToolCall) {
      await host.gateMcpToolCall(resolved.namespacedName, resolvedArgs, false, signal);
    }

    let rawResult: McpRawToolResult;
    if (resolved.server.connection.callToolRaw) {
      rawResult = await resolved.server.connection.callToolRaw(
        resolved.toolName,
        resolvedArgs,
        signal
      );
    } else {
      const legacy = await resolved.server.connection.callTool(
        resolved.toolName,
        resolvedArgs,
        signal
      );
      rawResult = {
        content: [{ type: "text", text: legacy.content }],
        isError: legacy.isError ?? false
      };
    }

    if (rawResult.isError) {
      const errText = rawResult.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      throw new A2uiExpressionError(
        `MCP tool '${requestedName}' failed: ${errText || "isError=true"}`,
        "callMcpTool"
      );
    }

    const processed = await coordinator.processToolResultResources({
      server: resolved.server,
      toolName: resolved.toolName,
      toolArgs: resolvedArgs,
      rawResult,
      processor: host.getProcessor(),
      onMcpAppResource: (appPayload) => host.onMcpAppResource?.(appPayload, surfaceId),
      signal
    });

    return processed.payload;
  };

  const callMcpToolImpl: FunctionImplementation = {
    ...CallMcpToolApi,
    execute: async (args, context, abortSignal) => {
      const toolName = String(context.resolveDynamicValue(args.name as never) ?? "").trim();
      const targetDataPath =
        args.targetDataPath !== undefined
          ? String(context.resolveDynamicValue(args.targetDataPath as never) ?? "").trim()
          : "";
      const serverName =
        args.server !== undefined
          ? String(context.resolveDynamicValue(args.server as never) ?? "").trim() || undefined
          : undefined;

      const isLatestCall = targetDataPath
        ? startCall(context.dataModel, context.resolvePath(targetDataPath))
        : () => true;

      try {
        const rawArguments = args.arguments ?? {};
        const resolvedArgs = await resolveDynamicArgsRecord(rawArguments, context);
        if (!isPlainRecord(resolvedArgs)) {
          throw new A2uiExpressionError(
            `MCP tool '${toolName}' arguments must resolve to an object.`,
            "callMcpTool"
          );
        }
        const payload = await executeDirectMcpTool(
          toolName,
          resolvedArgs,
          serverName,
          context.surface?.id,
          abortSignal
        );
        if (isLatestCall() && targetDataPath) {
          context.set(targetDataPath, payload);
        }
        return payload;
      } catch (err) {
        if (err instanceof A2uiExpressionError) throw err;
        throw new A2uiExpressionError(
          `Failed to execute MCP tool '${toolName}': ${err instanceof Error ? err.message : String(err)}`,
          "callMcpTool",
          err
        );
      }
    }
  };

  const transformDataImpl = createFunctionImplementation(TransformDataApi, (args) => {
    const expression = String(args.jmespath ?? "");
    return searchJmesPath(args.data, expression);
  });

  const updateDataModelImpl = createFunctionImplementation(UpdateDataModelApi, (args, context) => {
    const updates: unknown = args.updates;
    if (Array.isArray(updates) || typeof updates !== "object" || updates === null) {
      const kind = Array.isArray(updates) ? "array" : updates === null ? "null" : typeof updates;
      throw new A2uiExpressionError(
        `updateDataModel expects an object of data model paths, got ${kind}.`,
        "updateDataModel"
      );
    }
    const entries = Object.entries(updates as Record<string, unknown>);
    for (const [path] of entries) {
      validateUpdatePath(path);
    }
    for (const [path, value] of entries) {
      context.set(
        path,
        typeof value === "object" && value !== null ? structuredClone(value) : value
      );
    }
    return true;
  });

  const splitImpl = createFunctionImplementation(SplitApi, (args) => {
    const separator = String(args.separator ?? "");
    return mapTextValue(args.value, (item) =>
      separator === "" ? Array.from(item) : item.split(separator)
    );
  });

  const regexCaptureImpl = createFunctionImplementation(RegexCaptureApi, (args) => {
    const compiled = compileSafeRegex(String(args.pattern ?? ""), "regexCapture");
    return mapTextValue(args.value, (item) => {
      const match = compiled.exec(item);
      return match ? match.slice(1).map((group) => group ?? "") : null;
    });
  });

  const WasmhatchMcpApp = createComponentImplementation(McpAppApi, ({ props }) => {
    const rpc = useA2uiSurfaceRpc();
    const instanceId = useId();
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const [frameHeight, setFrameHeight] = useState<number>(DEFAULT_MCP_APP_HEIGHT);
    const [status, setStatus] = useState<"booting" | "ready" | "error">("booting");
    const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">("inline");

    const canRender = host.canUseMcp() || host.canUseArtifacts();
    const rawHtml = typeof props.htmlContent === "string" ? props.htmlContent : "";
    const decodedHtml = useMemo(() => decodeHtmlContent(rawHtml), [rawHtml]);
    const accessibleTitle =
      (typeof props.accessibility?.label === "string" && props.accessibility.label.trim()) ||
      (typeof props.title === "string" && props.title.trim()) ||
      t`Interactive app`;
    const resourceUri =
      typeof props.resourceUri === "string" && props.resourceUri.trim()
        ? props.resourceUri.trim()
        : "ui://embedded-app";

    const sandboxConfig = useMemo(() => resolveMcpSandboxConfig(), []);
    const permissions = useMemo(
      () =>
        props.permissions
          ? {
              camera: Boolean(props.permissions.camera),
              microphone: Boolean(props.permissions.microphone),
              geolocation: Boolean(props.permissions.geolocation),
              clipboardWrite: Boolean(props.permissions.clipboardWrite)
            }
          : undefined,
      [props.permissions]
    );

    const dataPaths = props.data?.paths as
      | Readonly<Record<string, string>>
      | readonly string[]
      | undefined;
    const allowedTools = props.allowedTools;
    const allowedFunctions = props.allowedFunctions as
      | Readonly<Record<string, unknown>>
      | readonly AllowedFunctionConfig[]
      | undefined;
    const toolInput = isPlainRecord(props.toolInput) ? props.toolInput : undefined;
    const toolResult = props.toolResult;
    const csp = props.csp as McpAppCspConfig | undefined;

    useEffect(() => {
      if (!canRender || !decodedHtml) return;
      const frame = frameRef.current;
      if (!frame || !frame.contentWindow) return;

      const surface = rpc?.surfaceId
        ? host.getProcessor().model.getSurface(rpc.surfaceId)
        : undefined;

      setStatus("booting");

      const bridge = new McpAppHostBridge({
        componentId: instanceId,
        resourceUri,
        html: decodedHtml,
        sandboxConfig,
        proxyWindow: frame.contentWindow,
        dataModel: surface?.dataModel,
        dataPaths,
        toolInput,
        toolResult,
        allowedTools,
        allowedFunctions,
        csp,
        permissions,
        locale: host.getLocale(),
        onHeightChange: (nextHeight) => setFrameHeight(nextHeight),
        onDisplayModeChange: (mode) => setDisplayMode(mode),
        onStatusChange: (nextStatus) => setStatus(nextStatus),
        callMcpTool: async (toolName, toolArgs, serverName) => {
          const payload = await executeDirectMcpTool(
            toolName,
            toolArgs,
            serverName,
            surface?.id
          );
          return payload.toolResult;
        },
        callCatalogFunction: async (fnName, fnArgs) => {
          if (!surface) {
            throw new Error("Surface model is unavailable.");
          }
          const ctx = new DataContext(surface, "/");
          return ctx.resolveDynamicValue({
            "@call": fnName,
            args: fnArgs
          } as never);
        },
        onOpenLink: (url) => {
          if (typeof window === "undefined") return false;
          window.open(url, "_blank", "noopener,noreferrer");
          return true;
        },
        onMessage: async (text) => {
          await rpc?.sendFollowUpMessage?.(text, accessibleTitle);
        }
      });

      const onWindowMessage = (event: MessageEvent) => {
        void bridge.handleWindowMessage(event);
      };
      window.addEventListener("message", onWindowMessage);

      return () => {
        window.removeEventListener("message", onWindowMessage);
        bridge.dispose();
      };
    }, [
      accessibleTitle,
      allowedFunctions,
      allowedTools,
      canRender,
      csp,
      dataPaths,
      decodedHtml,
      instanceId,
      permissions,
      resourceUri,
      rpc,
      sandboxConfig,
      toolInput,
      toolResult
    ]);

    if (!canRender) {
      return (
        <div className="a2ui-mcp-app-card" role="region" aria-label={accessibleTitle}>
          <p className="a2ui-field-error" role="alert">
            {t`Embedded apps are disabled for this hatchling.`}
          </p>
        </div>
      );
    }

    if (!decodedHtml) {
      return null;
    }

    return (
      <section
        className="a2ui-mcp-app-card"
        data-display-mode={displayMode}
        aria-label={accessibleTitle}
      >
        <header className="a2ui-mcp-app-header">
          <span className="a2ui-mcp-app-title">{accessibleTitle}</span>
          <span
            className="a2ui-status-pill"
            data-tone={status === "ready" ? "accent" : status === "error" ? "error" : "neutral"}
          >
            {status === "ready"
              ? sandboxConfig.mode === "isolated-origin"
                ? t`Isolated sandbox`
                : t`Sandboxed`
              : t`Loading…`}
          </span>
        </header>
        <iframe
          ref={frameRef}
          className="a2ui-mcp-app-frame"
          src={sandboxConfig.proxyUrl}
          sandbox={sandboxConfig.outerSandbox}
          referrerPolicy="no-referrer"
          title={accessibleTitle}
          height={frameHeight}
        />
      </section>
    );
  });

  return new Catalog<ReactCatalogComponent>(
    MCP_CATALOG_ID,
    "1.0",
    [WasmhatchMcpApp],
    [callMcpToolImpl, transformDataImpl, updateDataModelImpl, splitImpl, regexCaptureImpl],
    {
      schemaUri: "https://json-schema.org/draft/2020-12/schema",
      schemaId: MCP_CATALOG_ID,
      title: "A2UI Model Context Protocol (MCP) Catalog",
      description:
        "Sandboxed MCP App hosting (`McpApp`), direct UI-to-MCP tool execution (`callMcpTool`), and JMESPath/regex data transformation functions.",
      instructions:
        "Use `callMcpTool` paired with `transformData` and `updateDataModel` so buttons or filters refresh data directly from connected MCP tools without extra model turns, or embed interactive `ui://` HTML apps via `McpApp`.",
      declaredProtocolVersion: "1.0"
    }
  );
}
