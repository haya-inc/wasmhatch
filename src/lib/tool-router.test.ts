import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPermissionStore } from "./chat-permissions";
import { MemoryTextStore } from "./opfs-kv";
import { TicketBoard } from "./tickets";
import { assembleHatchlingTools, createHatchlingToolExecutor } from "./tool-router";
import { createWorkspaceStore } from "./workspace";

describe("tool-router", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assembles only connected connectors and confines packaged capabilities fail-closed", () => {
    const unrestricted = assembleHatchlingTools({
      capabilities: null,
      mcpServers: [],
      googleConnected: true,
      googlePickerAvailable: true,
      googleSensitiveEnabled: false,
      slackWebhookConnected: true,
      slackTokenConnected: false,
      tavilyFallbackActive: true,
      jinaConnected: false
    });
    const unrestrictedNames = unrestricted.map((tool) => tool.name);
    expect(unrestrictedNames).toContain("create_google_doc");
    expect(unrestrictedNames).toContain("open_google_file_picker");
    expect(unrestrictedNames).toContain("post_slack_message");
    expect(unrestrictedNames).toContain("web_search");
    expect(unrestrictedNames).not.toContain("fetch_page");

    const confined = assembleHatchlingTools({
      capabilities: ["workspace.read", "artifacts"],
      mcpServers: [],
      googleConnected: true,
      googlePickerAvailable: true,
      googleSensitiveEnabled: true,
      slackWebhookConnected: true,
      slackTokenConnected: true,
      tavilyFallbackActive: true,
      jinaConnected: true
    });
    expect(confined.map((tool) => tool.name)).toEqual(["list_files", "read_file", "create_artifact"]);
  });

  it("routes workspace, ticket, and artifact calls while recording tool journal entries", async () => {
    const meta = new MemoryTextStore();
    const tickets = new TicketBoard(meta);
    await tickets.ready();
    const workspace = createWorkspaceStore({ working: "test-router-ws", baseline: "test-router-bl" });
    await workspace.clear();

    const journalEvents: Array<{ category: string; outcome: string; summary: string }> = [];
    const artifacts: Array<{ title: string; html: string }> = [];
    const writes: string[] = [];

    const execute = createHatchlingToolExecutor({
      threadId: "main",
      workspace,
      permissions: new SessionPermissionStore(),
      gate: async () => "allow-once",
      policy: () => "autonomous",
      onAppliedWrite: (write) => writes.push(write.path),
      onArtifact: (artifact) => artifacts.push(artifact),
      tickets,
      google: { getToken: async () => "unused" },
      mcpServers: [],
      recordJournal: (entry) => journalEvents.push({ category: entry.category, outcome: entry.outcome, summary: entry.summary })
    });

    await execute("write_file", { path: "notes.md", content: "# Hello\n" }, {});
    await execute("create_ticket", { title: "Review Q3 numbers" }, {});
    await execute("create_artifact", { title: "Q3 Report", html: "<!doctype html><h1>Q3</h1>" }, {});

    expect(writes).toEqual(["notes.md"]);
    expect(tickets.list().map((ticket) => ticket.title)).toEqual(["Review Q3 numbers"]);
    expect(artifacts).toEqual([{ title: "Q3 Report", html: "<!doctype html><h1>Q3</h1>" }]);
    expect(journalEvents).toEqual([
      { category: "tool", outcome: "completed", summary: "write_file — notes.md" },
      { category: "tool", outcome: "completed", summary: "create_ticket — Review Q3 numbers" },
      { category: "tool", outcome: "completed", summary: "create_artifact — Q3 Report" }
    ]);
    await workspace.clear();
  });

  it("captures MCP tool errors as non-throwing error outcomes", async () => {
    const meta = new MemoryTextStore();
    const tickets = new TicketBoard(meta);
    const workspace = createWorkspaceStore({ working: "test-router-mcp-ws", baseline: "test-router-mcp-bl" });
    const recordJournal = vi.fn();

    const execute = createHatchlingToolExecutor({
      threadId: "main",
      workspace,
      permissions: new SessionPermissionStore(),
      gate: async () => "allow-once",
      policy: () => "autonomous",
      onAppliedWrite: () => {},
      onArtifact: () => {},
      tickets,
      google: { getToken: async () => "unused" },
      mcpServers: [{
        server: { id: "local", label: "Local", url: "http://localhost:3001/mcp", loopback: true, auth: "none" },
        url: "http://localhost:3001/mcp",
        error: null,
        toolset: {
          definitions: [{ name: "mcp__local__boom", description: "Boom", inputSchema: { type: "object" } }],
          routes: new Map([["mcp__local__boom", { serverId: "local", tool: "boom" }]])
        },
        connection: {
          initialize: async () => {},
          listTools: async () => [],
          callTool: async () => { throw new Error("server offline"); },
          close: async () => {}
        }
      }],
      recordJournal
    });

    const outcome = await execute("mcp__local__boom", {}, {});
    expect(outcome).toEqual({ content: "server offline", isError: true });
    expect(recordJournal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("gates external write tools in careful mode while letting readOnly MCP tools run unprompted", async () => {
    const meta = new MemoryTextStore();
    const tickets = new TicketBoard(meta);
    const workspace = createWorkspaceStore({ working: "test-router-careful-ws", baseline: "test-router-careful-bl" });
    const gateCalls: string[] = [];
    const callTool = vi.fn(async () => ({ content: "ok" }));

    const execute = createHatchlingToolExecutor({
      threadId: "main",
      workspace,
      permissions: new SessionPermissionStore(),
      gate: async (req) => {
        gateCalls.push(`${req.kind}:${req.path}`);
        return req.path.includes("mutator") ? "reject" : "allow-once";
      },
      policy: () => "careful",
      onAppliedWrite: () => {},
      onArtifact: () => {},
      tickets,
      google: { getToken: async () => "unused" },
      mcpServers: [{
        server: { id: "local", label: "Local", url: "http://localhost:3001/mcp", loopback: true, auth: "none" },
        url: "http://localhost:3001/mcp",
        error: null,
        toolset: {
          definitions: [
            { name: "mcp__local__reader", description: "Read", inputSchema: { type: "object" } },
            { name: "mcp__local__mutator", description: "Write", inputSchema: { type: "object" } }
          ],
          routes: new Map([
            ["mcp__local__reader", { serverId: "local", tool: "reader", readOnly: true }],
            ["mcp__local__mutator", { serverId: "local", tool: "mutator", readOnly: false }]
          ])
        },
        connection: {
          initialize: async () => {},
          listTools: async () => [],
          callTool,
          close: async () => {}
        }
      }],
      recordJournal: () => {}
    });

    const readRes = await execute("mcp__local__reader", {}, {});
    expect(readRes.isError).toBeFalsy();
    expect(gateCalls).toEqual([]);

    const writeRes = await execute("mcp__local__mutator", {}, {});
    expect(writeRes.isError).toBe(true);
    expect(writeRes.content).toContain("rejected");
    expect(gateCalls).toEqual(["external:external:mcp__local__mutator"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
