/**
 * MCP server registry.
 *
 * Same posture as the model-provider registry: the CSP `connect-src` list is
 * generated from this audited registry at build time, never relaxed to a
 * wildcard origin (CONTRIBUTING.md). Out of the box that means loopback —
 * any Streamable-HTTP MCP server on the user's own machine, on any port —
 * plus whatever remote MCP origins a deployment bakes in through
 * `VITE_EXTRA_MCP_SERVERS` (a JSON array of {id, label, url, auth}).
 * A user of the hosted site cannot point the page at an arbitrary remote
 * origin at runtime; that is the documented trade, not an accident.
 */

export interface McpServerDef {
  /** Stable id, also the tool namespace: tools surface as mcp_<id>_<tool>. */
  id: string;
  label: string;
  /** Full Streamable HTTP endpoint URL (e.g. http://localhost:3001/mcp). */
  url: string;
  auth: "none" | "bearer";
  /** The built-in local entry: URL stays user-editable within loopback. */
  loopback: boolean;
}

export const LOCAL_MCP_SERVER_ID = "local";
export const MAX_EXTRA_MCP_SERVERS = 8;

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LOCAL_TEMPLATE: McpServerDef = Object.freeze({
  id: LOCAL_MCP_SERVER_ID,
  label: "Local MCP server",
  url: "http://localhost:3001/mcp",
  auth: "none",
  loopback: true
});

export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
}

/** Parses the deployment's extra remote servers; anything malformed is dropped. */
export function parseExtraMcpServers(raw: string | undefined | null): McpServerDef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const servers: McpServerDef[] = [];
  const seen = new Set<string>([LOCAL_MCP_SERVER_ID]);
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !SERVER_ID_PATTERN.test(record.id) || seen.has(record.id)) continue;
    if (typeof record.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      continue;
    }
    // Remote MCP must be https; loopback belongs to the built-in entry.
    if (url.protocol !== "https:" || isLoopbackUrl(record.url)) continue;
    const label = typeof record.label === "string" && record.label.trim()
      ? record.label.trim().slice(0, 60)
      : url.hostname;
    servers.push({
      id: record.id,
      label,
      url: url.toString(),
      auth: record.auth === "bearer" ? "bearer" : "none",
      loopback: false
    });
    seen.add(record.id);
    if (servers.length >= MAX_EXTRA_MCP_SERVERS) break;
  }
  return servers;
}

export function buildMcpServers(extraRaw?: string | null): McpServerDef[] {
  return [LOCAL_TEMPLATE, ...parseExtraMcpServers(extraRaw)];
}

/**
 * CSP connect-src entries for a registry: wildcard-port loopback for the
 * local entry (the port is the user's choice), exact origins for remote
 * entries. Loopback-only http is the same audited exception Ollama uses.
 */
export function mcpConnectSources(servers: readonly McpServerDef[]): string[] {
  const sources: string[] = [];
  if (servers.some((server) => server.loopback)) {
    sources.push("http://localhost:*", "http://127.0.0.1:*");
  }
  for (const server of servers) {
    if (server.loopback) continue;
    sources.push(new URL(server.url).origin);
  }
  return [...new Set(sources)];
}

/**
 * Runtime guard mirroring the CSP (defense in depth): a URL is reachable
 * only when it is loopback or exactly on a registered remote origin.
 */
export function isAllowedMcpUrl(url: string, servers: readonly McpServerDef[]): boolean {
  if (isLoopbackUrl(url)) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return servers.some((server) => !server.loopback && new URL(server.url).origin === origin);
}

function readBuildTimeExtras(): string | undefined {
  // Safe under Vite (app build), Vitest, and plain-node config loading alike.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_EXTRA_MCP_SERVERS;
}

/** The app's registry, fixed at build time like the model-provider list. */
export const MCP_SERVERS: readonly McpServerDef[] = buildMcpServers(readBuildTimeExtras());

export const MCP_CONNECT_SRCS: readonly string[] = mcpConnectSources(MCP_SERVERS);
