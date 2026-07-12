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

export type AgentContentPart = AgentTextPart | AgentToolCallPart | AgentToolResultPart;

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  parts: AgentContentPart[];
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentStopReason = "end-turn" | "tool-use" | "max-output-tokens" | "other";

/** Incremental events emitted by a provider adapter while streaming one assistant message. */
export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-start"; index: number; callId: string; name: string }
  | { type: "tool-call-args-delta"; index: number; argsJsonDelta: string }
  | { type: "tool-call-end"; index: number }
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
  | { type: "usage"; usage: AgentBudgetUsage; budget: AgentSoftBudget }
  | { type: "final"; text: string };

export type AgentLoopStatus = "completed" | "budget-exhausted" | "cancelled";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  finalText: string;
  messages: AgentMessage[];
  usage: AgentBudgetUsage;
}
