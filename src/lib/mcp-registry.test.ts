import { describe, expect, it, vi } from "vitest";
import { McpRegistry, type McpConnectionLike } from "./mcp-registry";
import type { McpServerDef } from "./mcp-servers";

const SERVERS: readonly McpServerDef[] = [
  { id: "local", label: "Local MCP", url: "http://localhost:3001/mcp", loopback: true, auth: "none" },
  { id: "audited", label: "Audited Remote", url: "https://mcp.example.com/v1", loopback: false, auth: "bearer" }
];

function fakeConnection(tools = [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]): McpConnectionLike {
  return {
    initialize: vi.fn(async () => {}),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ content: "pong" })),
    close: vi.fn(async () => {})
  };
}

describe("McpRegistry", () => {
  it("connects a loopback server, builds its namespaced toolset, and disconnects cleanly", async () => {
    const onChange = vi.fn();
    const conn = fakeConnection();
    const registry = new McpRegistry({
      servers: SERVERS,
      onChange,
      createConnection: () => conn
    });

    const count = await registry.connect("local", { url: "http://127.0.0.1:4000/mcp" });
    expect(count).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(registry.status()[0]).toMatchObject({
      connected: true,
      toolCount: 1,
      url: "http://127.0.0.1:4000/mcp"
    });
    expect(registry.activeServers()).toHaveLength(1);

    await registry.disconnect("local");
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(registry.activeServers()).toHaveLength(0);
  });

  it("blocks non-loopback URLs for local servers and un-allowlisted origins for remote servers", async () => {
    const createConnection = vi.fn(() => fakeConnection());
    const registry = new McpRegistry({ servers: SERVERS, createConnection });

    await expect(registry.connect("local", { url: "https://evil.example.com/mcp" }))
      .rejects.toThrow(/must stay on this machine/);
    await expect(registry.connect("audited", { url: "https://other.example.com/mcp" }))
      .rejects.toThrow(/outside this deployment's audited MCP allowlist/);
    expect(createConnection).not.toHaveBeenCalled();
  });
});
