/**
 * Unified agent-core contracts shared by every model provider.
 *
 * This module defines the single internal message, tool, and streaming-event
 * schema that provider adapters (Anthropic, OpenAI-compatible, Chrome built-in
 * AI) translate to and from. UI code and tool executors depend only on these
 * types, never on a provider wire format.
 *
 * Budgets here are deliberately soft and caller-raisable. They exist so the
 * user can see and control spend, not to cap capability with hidden ceilings.
 */

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: Record<string, unknown>;
}

export type AgentToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: { signal?: AbortSignal }
) => Promise<AgentToolOutcome>;

export interface AgentToolOutcome {
  content: string;
  isError?: boolean;
}

export interface AgentTextPart {
  type: "text";
  text: string;
}

export interface AgentToolCallPart {
  type: "tool_call";
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolResultPart {
  type: "tool_result";
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * A provider-owned content block carried through the transcript verbatim —
 * e.g. Anthropic server-tool blocks (web search) that must round-trip in
 * history exactly as received. Only the adapter whose id matches replays it;
 * the loop and UI treat it as opaque data.
 */
export interface AgentProviderRawPart {
  type: "provider_raw";
  providerId: string;
  block: Record<string, unknown>;
}

export type AgentContentPart = AgentTextPart | AgentToolCallPart | AgentToolResultPart | AgentProviderRawPart;

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  parts: AgentContentPart[];
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentStopReason = "end-turn" | "tool-use" | "max-output-tokens" | "pause-turn" | "other";

/** Incremental events emitted by a provider adapter while streaming one assistant message. */
export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-start"; index: number; callId: string; name: string }
  | { type: "tool-call-args-delta"; index: number; argsJsonDelta: string }
  | { type: "tool-call-end"; index: number }
  /** A tool the provider executed on its own servers (e.g. web search) — no client execution. */
  | { type: "server-tool-call"; callId: string; name: string; args: Record<string, unknown>; block: Record<string, unknown> }
  | { type: "server-tool-result"; callId: string; name: string; isError: boolean; block: Record<string, unknown> }
  /**
   * A provider-owned block that must round-trip in history verbatim but needs
   * no loop handling or UI (e.g. OpenAI Responses reasoning items, which the
   * API requires alongside the function calls they precede). Stored as an
   * AgentProviderRawPart at its wire position.
   */
  | { type: "provider-raw"; block: Record<string, unknown> }
  /** A source the provider cited while generating text (e.g. a web search hit). */
  | { type: "citation"; url: string; title: string }
  | { type: "message-end"; stopReason: AgentStopReason; usage?: AgentUsage };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: readonly AgentMessage[];
  tools: readonly AgentToolDefinition[];
  maxOutputTokens: number;
  temperature?: number;
}

/**
 * A model provider that streams one assistant turn.
 *
 * Adapters own transport, authentication, retry on transient failures, and
 * translation of wire events into ProviderStreamEvent values. They must never
 * log or embed credentials in thrown errors.
 */
export interface AgentProvider {
  readonly id: string;
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void>;
}

/**
 * Soft budgets. Exhaustion ends the run with status "budget-exhausted" so the
 * caller can raise the limit and resume with the preserved transcript; it is
 * never a thrown error and never a hidden hard cap.
 */
export interface AgentSoftBudget {
  maxTurns: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

export const DEFAULT_AGENT_BUDGET: AgentSoftBudget = Object.freeze({
  maxTurns: 64,
  maxOutputTokens: 262_144,
  maxToolCalls: 256
});

export interface AgentBudgetUsage {
  turns: number;
  outputTokens: number;
  inputTokens: number;
  toolCalls: number;
}

export type AgentLoopEvent =
  | { type: "turn-start"; turn: number }
  | { type: "text-delta"; turn: number; text: string }
  | { type: "tool-call"; turn: number; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; turn: number; callId: string; name: string; content: string; isError: boolean; durationMs: number }
  | { type: "citation"; turn: number; url: string; title: string }
  | { type: "usage"; usage: AgentBudgetUsage; budget: AgentSoftBudget }
  | { type: "final"; text: string };

export type AgentLoopStatus = "completed" | "budget-exhausted" | "cancelled";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  finalText: string;
  messages: AgentMessage[];
  usage: AgentBudgetUsage;
}
