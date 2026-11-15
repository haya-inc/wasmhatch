/**
 * Hatchling tool surface assembly and unified tool execution router.
 *
 * Keeps connector wiring, capability allowlist confinement, MCP tool routing,
 * and tool-level journal recording in one cohesive module so `HatchlingSwarm`
 * only manages thread runtime state and agent loops.
 */

import type { AgentToolDefinition, AgentToolExecutor } from "./agent-core/types";
import { ARTIFACT_TOOL, createArtifactExecutor } from "./artifact";
import { runBusinessScriptInWorker } from "./browser-script-runner";
import type { PermissionGate, SessionPermissionStore } from "./chat-permissions";
import { CHAT_SCRIPT_LIMITS, CHAT_TOOLS, createChatToolExecutor, type AppliedWrite, type WritePolicy } from "./chat-tools";
import { GOOGLE_CONNECTOR_TOOLS, createGoogleConnectorExecutor } from "./google-connectors";
import { GOOGLE_PICKER_TOOL, createGooglePickerExecutor, type PickedDriveFile } from "./google-picker";
import { GOOGLE_SENSITIVE_TOOLS, createGoogleSensitiveExecutor } from "./google-sensitive-connectors";
import { filterToolsByCapabilities } from "./hatchling-capabilities";
import type { McpConnectedServer } from "./mcp-registry";
import type { appendRunJournalEvent } from "./run-journal";
import { SLACK_API_TOOLS, createSlackApiExecutor, slackProxyBaseUrl } from "./slack-tools";
import { SLACK_WEBHOOK_TOOLS, createSlackWebhookExecutor } from "./slack-webhook";
import { TICKET_TOOLS, createTicketToolExecutor, type TicketBoard } from "./tickets";
import { FETCH_PAGE_TOOL, WEB_SEARCH_FALLBACK_TOOL, createWebToolExecutor } from "./web-tools";
import type { WorkspaceStore } from "./workspace";

export type JournalRecorder = (input: Parameters<typeof appendRunJournalEvent>[1]) => void;

export interface ToolAssemblyInput {
  capabilities: readonly string[] | null;
  mcpServers: readonly McpConnectedServer[];
  googleConnected: boolean;
  googlePickerAvailable: boolean;
  googleSensitiveEnabled: boolean;
  slackWebhookConnected: boolean;
  slackTokenConnected: boolean;
  tavilyFallbackActive: boolean;
  jinaConnected: boolean;
}

export function assembleHatchlingTools(input: ToolAssemblyInput): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    ...CHAT_TOOLS,
    ARTIFACT_TOOL,
    ...TICKET_TOOLS,
    ...(input.googleConnected ? GOOGLE_CONNECTOR_TOOLS : []),
    ...(input.googleConnected && input.googlePickerAvailable ? [GOOGLE_PICKER_TOOL] : []),
    ...(input.googleConnected && input.googleSensitiveEnabled ? GOOGLE_SENSITIVE_TOOLS : []),
    ...(input.slackWebhookConnected ? SLACK_WEBHOOK_TOOLS : []),
    ...(input.slackTokenConnected ? SLACK_API_TOOLS : []),
    ...(input.tavilyFallbackActive ? [WEB_SEARCH_FALLBACK_TOOL] : []),
    ...(input.jinaConnected ? [FETCH_PAGE_TOOL] : []),
    ...input.mcpServers.flatMap((entry) => entry.toolset.definitions)
  ];
  // A packaged hatchling's capability list is an allowlist that fails closed;
  // ordinary hatchlings (null) keep the full connected surface.
  return filterToolsByCapabilities(tools, input.capabilities);
}

export interface HatchlingToolRouterOptions {
  threadId: string;
  workspace: WorkspaceStore;
  permissions: SessionPermissionStore;
  gate: PermissionGate;
  policy: () => WritePolicy;
  onAppliedWrite: (write: AppliedWrite) => void;
  onArtifact: (artifact: { title: string; html: string }) => void;
  tickets: TicketBoard;
  google: {
    getToken: (signal?: AbortSignal) => Promise<string>;
    requestFilePick?: (reason: string, signal?: AbortSignal) => Promise<PickedDriveFile[] | null>;
  };
  slack?: { getWebhookUrl: () => string; getToken?: () => string };
  web?: { getTavilyKey: () => string; getJinaKey: () => string };
  mcpServers: readonly McpConnectedServer[];
  recordJournal: JournalRecorder;
}

const GOOGLE_TOOL_NAMES = new Set(GOOGLE_CONNECTOR_TOOLS.map((tool) => tool.name));
const GOOGLE_SENSITIVE_TOOL_NAMES = new Set(GOOGLE_SENSITIVE_TOOLS.map((tool) => tool.name));
const SLACK_WEBHOOK_TOOL_NAMES = new Set(SLACK_WEBHOOK_TOOLS.map((tool) => tool.name));
const SLACK_API_TOOL_NAMES = new Set(SLACK_API_TOOLS.map((tool) => tool.name));
const TICKET_TOOL_NAMES = new Set(TICKET_TOOLS.map((tool) => tool.name));

export function createHatchlingToolExecutor(options: HatchlingToolRouterOptions): AgentToolExecutor {
  const workspaceExecute = createChatToolExecutor({
    workspace: options.workspace,
    permissions: options.permissions,
    gate: options.gate,
    policy: options.policy,
    onAppliedWrite: options.onAppliedWrite,
    runScript: (source, scriptInput, runOptions) =>
      runBusinessScriptInWorker(source, scriptInput, { limits: CHAT_SCRIPT_LIMITS, signal: runOptions.signal })
  });
  const artifactExecute = createArtifactExecutor(options.onArtifact);
  const googleExecute = createGoogleConnectorExecutor(options.google.getToken);
  const googleSensitiveExecute = createGoogleSensitiveExecutor(options.google.getToken);
  const pickerExecute = createGooglePickerExecutor(
    (reason, signal) => options.google.requestFilePick?.(reason, signal) ?? Promise.resolve(null)
  );
  const slackExecute = createSlackWebhookExecutor(() => options.slack?.getWebhookUrl() ?? "");
  const slackApiExecute = createSlackApiExecutor(
    () => options.slack?.getToken?.() ?? "",
    { baseUrl: slackProxyBaseUrl() }
  );
  const webExecute = createWebToolExecutor(() => ({
    tavily: options.web?.getTavilyKey() ?? "",
    jina: options.web?.getJinaKey() ?? ""
  }));
  const ticketExecute = createTicketToolExecutor(options.tickets, options.threadId);

  const mcpRoutes = new Map<string, { server: McpConnectedServer; tool: string }>();
  for (const mcpServer of options.mcpServers) {
    for (const [name, route] of mcpServer.toolset.routes) {
      mcpRoutes.set(name, { server: mcpServer, tool: route.tool });
    }
  }

  const dispatch: AgentToolExecutor = async (name, args, context) => {
    if (name === ARTIFACT_TOOL.name) return artifactExecute(name, args, context);
    if (TICKET_TOOL_NAMES.has(name)) return ticketExecute(name, args, context);
    if (GOOGLE_TOOL_NAMES.has(name)) return googleExecute(name, args, context);
    if (name === GOOGLE_PICKER_TOOL.name) return pickerExecute(name, args, context);
    if (GOOGLE_SENSITIVE_TOOL_NAMES.has(name)) return googleSensitiveExecute(name, args, context);
    if (SLACK_WEBHOOK_TOOL_NAMES.has(name)) return slackExecute(name, args, context);
    if (SLACK_API_TOOL_NAMES.has(name)) return slackApiExecute(name, args, context);
    if (name === WEB_SEARCH_FALLBACK_TOOL.name || name === FETCH_PAGE_TOOL.name) return webExecute(name, args, context);
    const mcpRoute = mcpRoutes.get(name);
    if (mcpRoute) {
      try {
        return await mcpRoute.server.connection.callTool(mcpRoute.tool, args, context?.signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return { content: error instanceof Error ? error.message : "MCP tool failed.", isError: true };
      }
    }
    return workspaceExecute(name, args, context);
  };

  return async (name, args, context) => {
    const target = typeof args.path === "string" ? args.path : typeof args.title === "string" ? args.title : "";
    const summary = target ? `${name} — ${target}` : name;
    try {
      const outcome = await dispatch(name, args, context);
      options.recordJournal({
        category: "tool",
        outcome: outcome.isError ? "failed" : "completed",
        summary,
        evidence: { tool: name, result_chars: outcome.content.length }
      });
      return outcome;
    } catch (error) {
      options.recordJournal({
        category: "tool",
        outcome: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed",
        summary,
        evidence: { tool: name }
      });
      throw error;
    }
  };
}
