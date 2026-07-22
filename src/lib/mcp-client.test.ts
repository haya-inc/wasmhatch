import { describe, expect, it } from "vitest";
import { buildMcpToolset, McpConnection, MCP_PROTOCOL_VERSION } from "./mcp-client";
import {
  buildMcpServers,
  isAllowedMcpUrl,
  isLoopbackUrl,
  mcpConnectSources,
  parseExtraMcpServers
} from "./mcp-servers";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fakeServer(respond: (request: RecordedRequest, index: number) => Response) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    };
    requests.push(request);
    return respond(request, requests.length - 1);
  };
  return { requests, fetchImpl };
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function sseResponse(messages: unknown[], headers: Record<string, string> = {}): Response {
  const body = messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers }
  });
}

function initializeResult(id: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake-mcp", version: "1.0" }
    }
  };
}

describe("McpConnection", () => {
  it("negotiates, keeps the session id, and announces initialized", async () => {
    const { requests, fetchImpl } = fakeServer((request, index) => {
      if (index === 0) return jsonResponse(initializeResult(request.body?.id), { "Mcp-Session-Id": "session-1" });
      return new Response(null, { status: 202 });
    });
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", fetchImpl });
    await connection.initialize();
    expect(connection.serverName).toBe("fake-mcp");
    expect(requests[0].body).toMatchObject({
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "WasmHatch" } }
    });
    expect(requests[1].body).toMatchObject({ method: "notifications/initialized" });
    expect(requests[1].body?.id).toBeUndefined();
    expect(requests[1].headers["Mcp-Session-Id"]).toBe("session-1");
    expect(requests[1].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
  });

  it("reads responses delivered as an SSE stream", async () => {
    const { fetchImpl } = fakeServer((request, index) => {
      if (index === 0) return jsonResponse(initializeResult(request.body?.id));
      if (index === 1) return new Response(null, { status: 202 });
      return sseResponse([
        { jsonrpc: "2.0", method: "notifications/progress", params: {} },
        { jsonrpc: "2.0", id: request.body?.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] } }
      ]);
    });
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", fetchImpl });
    await connection.initialize();
    const tools = await connection.listTools();
    expect(tools).toEqual([{ name: "echo", description: "Echo", inputSchema: { type: "object" } }]);
  });

  it("paginates tools/list and skips malformed entries", async () => {
    const { requests, fetchImpl } = fakeServer((request, index) => {
      if (index === 0) return jsonResponse(initializeResult(request.body?.id));
      if (index === 1) return new Response(null, { status: 202 });
      if (index === 2) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.body?.id,
          result: { tools: [{ name: "first" }, { bogus: true }, 42], nextCursor: "page2" }
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.body?.id,
        result: { tools: [{ name: "second", description: "2nd" }] }
      });
    });
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", fetchImpl });
    await connection.initialize();
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(requests[3].body?.params).toEqual({ cursor: "page2" });
    // Missing schemas become a permissive object schema instead of undefined.
    expect(tools[0].inputSchema).toEqual({ type: "object" });
  });

  it("flattens tool results and carries the server's isError flag", async () => {
    const { requests, fetchImpl } = fakeServer((request, index) => {
      if (index === 0) return jsonResponse(initializeResult(request.body?.id));
      if (index === 1) return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.body?.id,
        result: {
          content: [
            { type: "text", text: "line one" },
            { type: "image", data: "…", mimeType: "image/png" },
            { type: "resource_link", uri: "file:///report.csv" }
          ],
          isError: true
        }
      });
    });
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", fetchImpl });
    await connection.initialize();
    const outcome = await connection.callTool("echo", { value: 1 });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toBe("line one\n[image content omitted]\n[resource: file:///report.csv]");
    expect(requests[2].body).toMatchObject({ method: "tools/call", params: { name: "echo", arguments: { value: 1 } } });
  });

  it("translates JSON-RPC errors and auth failures without leaking the token", async () => {
    const { fetchImpl } = fakeServer((request, index) => {
      if (index === 0) return jsonResponse(initializeResult(request.body?.id));
      if (index === 1) return new Response(null, { status: 202 });
      if (index === 2) {
        return jsonResponse({ jsonrpc: "2.0", id: request.body?.id, error: { code: -32602, message: "bad arguments" } });
      }
      return new Response("denied", { status: 401 });
    });
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", bearerToken: "secret-token", fetchImpl });
    await connection.initialize();
    await expect(connection.callTool("echo", {})).rejects.toThrow(/bad arguments/);
    const authFailure = await connection.callTool("echo", {}).catch((error: Error) => error);
    expect(authFailure).toBeInstanceOf(Error);
    expect((authFailure as Error).message).toMatch(/rejected authentication \(HTTP 401\)/);
    expect((authFailure as Error).message).not.toContain("secret-token");
  });

  it("sends the bearer token only as the Authorization header", async () => {
    const { requests, fetchImpl } = fakeServer((request) => jsonResponse(initializeResult(request.body?.id)));
    const connection = new McpConnection({ url: "http://localhost:3001/mcp", bearerToken: "secret-token", fetchImpl });
    await connection.initialize().catch(() => undefined);
    expect(requests[0].headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.stringify(requests[0].body)).not.toContain("secret-token");
  });
});

describe("buildMcpToolset", () => {
  it("namespaces, sanitizes, and de-collides tool names while routing to originals", () => {
    const toolset = buildMcpToolset("local", "Local MCP server", [
      { name: "files/read", description: "Read a file", inputSchema: { type: "object" } },
      { name: "files_read", description: "Colliding cousin", inputSchema: { type: "object" } },
      { name: "x".repeat(100), description: "Long", inputSchema: { type: "object" } }
    ]);
    const names = toolset.definitions.map((definition) => definition.name);
    expect(names[0]).toBe("mcp_local_files_read");
    expect(names[1]).not.toBe(names[0]);
    expect(names[2].length).toBeLessThanOrEqual(64);
    expect(new Set(names).size).toBe(3);
    expect(toolset.routes.get(names[0])).toEqual({ serverId: "local", tool: "files/read" });
    expect(toolset.routes.get(names[1])).toEqual({ serverId: "local", tool: "files_read" });
    expect(toolset.definitions[0].description).toContain("[Local MCP server via MCP]");
  });
});

describe("mcp server registry", () => {
  it("always offers the loopback entry and validates deployment extras", () => {
    const servers = buildMcpServers(JSON.stringify([
      { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", auth: "bearer" },
      { id: "local", label: "Shadowing the built-in", url: "https://evil.example/mcp" },
      { id: "BadId", url: "https://ok.example/mcp" },
      { id: "http-only", url: "http://insecure.example/mcp" },
      { id: "loop", url: "https://localhost:9999/mcp" },
      { id: "broken", url: "not a url" }
    ]));
    expect(servers.map((server) => server.id)).toEqual(["local", "linear"]);
    expect(servers[1]).toMatchObject({ auth: "bearer", loopback: false });
    expect(buildMcpServers(undefined).map((server) => server.id)).toEqual(["local"]);
    expect(parseExtraMcpServers("{broken")).toEqual([]);
  });

  it("derives CSP sources: wildcard-port loopback plus exact remote origins", () => {
    const servers = buildMcpServers(JSON.stringify([
      { id: "linear", url: "https://mcp.linear.app/sse/mcp" }
    ]));
    expect(mcpConnectSources(servers)).toEqual([
      "http://localhost:*",
      "http://127.0.0.1:*",
      "https://mcp.linear.app"
    ]);
  });

  it("guards runtime URLs the same way the CSP does", () => {
    const servers = buildMcpServers(JSON.stringify([{ id: "linear", url: "https://mcp.linear.app/mcp" }]));
    expect(isLoopbackUrl("http://localhost:8000/mcp")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:1234/x")).toBe(true);
    expect(isLoopbackUrl("http://evil.example/mcp")).toBe(false);
    expect(isLoopbackUrl("ftp://localhost/mcp")).toBe(false);
    expect(isAllowedMcpUrl("http://localhost:9000/anything", servers)).toBe(true);
    expect(isAllowedMcpUrl("https://mcp.linear.app/other-path", servers)).toBe(true);
    expect(isAllowedMcpUrl("https://evil.example/mcp", servers)).toBe(false);
  });
});
