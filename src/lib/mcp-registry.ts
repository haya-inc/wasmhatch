/**
 * Runtime registry for Streamable-HTTP MCP server connections shared across hatchlings.
 *
 * Enforces loopback / deployment-allowlist URL rules before any network
 * handshake and exposes active toolsets for tool assembly and routing.
 */

import type { AgentToolOutcome } from "./agent-core/types";
import {
  buildMcpToolset,
  McpConnection,
  type McpRawToolResult,
  type McpReadResourceResult,
  type McpToolInfo,
  type McpToolset
} from "./mcp-client";
import { isAllowedMcpUrl, isLoopbackUrl, MCP_SERVERS, type McpServerDef } from "./mcp-servers";

export interface McpServerStatus {
  server: McpServerDef;
  connected: boolean;
  toolCount: number;
  url: string;
  error: string | null;
}

export interface McpConnectionLike {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome>;
  callToolRaw?(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpRawToolResult>;
  readResource?(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult>;
  close(): Promise<void>;
}

export interface McpConnectedServer {
  readonly server: McpServerDef;
  readonly url: string;
  readonly connection: McpConnectionLike;
  readonly toolset: McpToolset;
  readonly tools?: readonly McpToolInfo[];
  readonly error: string | null;
}

export interface McpRegistryOptions {
  servers?: readonly McpServerDef[];
  onChange?: () => void;
  createConnection?: (options: { url: string; bearerToken?: string }) => McpConnectionLike;
}

export class McpRegistry {
  private readonly servers: readonly McpServerDef[];
  private readonly onChange?: () => void;
  private readonly createConnection: (options: { url: string; bearerToken?: string }) => McpConnectionLike;
  private readonly runtimes = new Map<string, McpConnectedServer>();

  constructor(options: McpRegistryOptions = {}) {
    this.servers = options.servers ?? MCP_SERVERS;
    this.onChange = options.onChange;
    this.createConnection = options.createConnection ?? ((connOptions) => new McpConnection(connOptions));
  }

  status(): McpServerStatus[] {
    return this.servers.map((server) => {
      const runtime = this.runtimes.get(server.id);
      return {
        server,
        connected: Boolean(runtime && !runtime.error),
        toolCount: runtime?.toolset.definitions.length ?? 0,
        url: runtime?.url ?? server.url,
        error: runtime?.error ?? null
      };
    });
  }

  activeServers(): McpConnectedServer[] {
    return [...this.runtimes.values()].filter((entry) => !entry.error);
  }

  async connect(serverId: string, options: { url?: string; bearerToken?: string } = {}): Promise<number> {
    const server = this.servers.find((entry) => entry.id === serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    const url = (options.url ?? server.url).trim();
    if (server.loopback && !isLoopbackUrl(url)) {
      throw new Error("The local MCP server must stay on this machine (http://localhost or http://127.0.0.1).");
    }
    if (!server.loopback && !isAllowedMcpUrl(url, [server])) {
      throw new Error("That URL is outside this deployment's audited MCP allowlist.");
    }
    await this.disconnect(serverId, false);
    const connection = this.createConnection({ url, bearerToken: options.bearerToken || undefined });
    try {
      await connection.initialize();
      const tools = await connection.listTools();
      const toolset = buildMcpToolset(server.id, server.label, tools);
      this.runtimes.set(serverId, { server, url, connection, toolset, tools, error: null });
      this.onChange?.();
      return toolset.definitions.length;
    } catch (error) {
      void connection.close();
      throw error instanceof Error ? error : new Error("MCP connection failed.");
    }
  }

  async disconnect(serverId: string, notify = true): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    this.runtimes.delete(serverId);
    await runtime.connection.close();
    if (notify) this.onChange?.();
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      void runtime.connection.close();
    }
    this.runtimes.clear();
  }
}
