/**
 * Provider-agnostic streaming agent loop.
 *
 * One loop drives every model provider through the AgentProvider interface:
 * stream an assistant turn, execute any requested tools in parallel, feed the
 * results back, repeat until the model answers without tools. Budgets are
 * soft — exhaustion ends the run with a resumable transcript instead of a
 * thrown error — and cancellation is graceful at every await point.
 */

import type {
  AgentLoopEvent,
  AgentLoopResult,
  AgentMessage,
  AgentProvider,
  AgentSoftBudget,
  AgentStopReason,
  AgentToolDefinition,
  AgentToolExecutor,
  AgentToolResultPart,
  AgentBudgetUsage
} from "./types";
import { DEFAULT_AGENT_BUDGET } from "./types";

const DEFAULT_MAX_OUTPUT_TOKENS_PER_TURN = 8_192;

export interface AgentLoopRequest {
  provider: AgentProvider;
  model: string;
  system: string;
  /** Prior transcript to continue, or start fresh with `task`. */
  messages?: readonly AgentMessage[];
  task?: string;
  tools: readonly AgentToolDefinition[];
  execute: AgentToolExecutor;
  budget?: Partial<AgentSoftBudget>;
  maxOutputTokensPerTurn?: number;
  temperature?: number;
  onEvent?: (event: AgentLoopEvent) => void;
  signal?: AbortSignal;
}

interface PendingToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseToolArgs(argsJson: string): { args: Record<string, unknown> } | { parseError: string } {
  const trimmed = argsJson.trim();
  if (!trimmed) return { args: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { parseError: "Tool arguments must be a JSON object." };
    }
    return { args: parsed as Record<string, unknown> };
  } catch {
    return { parseError: "Tool arguments were not valid JSON." };
  }
}

export async function runAgentLoop(request: AgentLoopRequest): Promise<AgentLoopResult> {
  if (!request.messages?.length && !request.task?.trim()) {
    throw new Error("Agent loop needs a task or a prior transcript.");
  }
  const budget: AgentSoftBudget = { ...DEFAULT_AGENT_BUDGET, ...request.budget };
  const maxOutputTokensPerTurn = request.maxOutputTokensPerTurn ?? DEFAULT_MAX_OUTPUT_TOKENS_PER_TURN;
  const messages: AgentMessage[] = request.messages
    ? request.messages.map((message) => ({ role: message.role, parts: [...message.parts] }))
    : [];
  if (request.task?.trim()) {
    messages.push({ role: "user", parts: [{ type: "text", text: request.task.trim() }] });
  }

  const usage: AgentBudgetUsage = { turns: 0, outputTokens: 0, inputTokens: 0, toolCalls: 0 };
  let finalText = "";

  const emit = (event: AgentLoopEvent) => request.onEvent?.(event);
  const finish = (status: AgentLoopResult["status"]): AgentLoopResult => ({
    status,
    finalText,
    messages,
    usage
  });

  for (;;) {
    if (request.signal?.aborted) return finish("cancelled");
    if (usage.turns >= budget.maxTurns) return finish("budget-exhausted");
    if (usage.outputTokens >= budget.maxOutputTokens) return finish("budget-exhausted");
    if (usage.toolCalls >= budget.maxToolCalls) return finish("budget-exhausted");

    usage.turns += 1;
    emit({ type: "turn-start", turn: usage.turns });

    let turnText = "";
    const pendingCalls = new Map<number, PendingToolCall>();
    // Streamed parts in wire order, so server-tool blocks (executed on the
    // provider's side) replay in history exactly where they appeared.
    const streamedParts: AgentMessage["parts"] = [];
    let stopReason: AgentStopReason = "other";

    try {
      const stream = request.provider.stream(
        {
          model: request.model,
          system: request.system,
          messages,
          tools: request.tools,
          maxOutputTokens: maxOutputTokensPerTurn,
          temperature: request.temperature
        },
        request.signal
      );
      for await (const event of stream) {
        if (event.type === "text-delta") {
          turnText += event.text;
          const last = streamedParts[streamedParts.length - 1];
          if (last?.type === "text") last.text += event.text;
          else streamedParts.push({ type: "text", text: event.text });
          emit({ type: "text-delta", turn: usage.turns, text: event.text });
        } else if (event.type === "tool-call-start") {
          pendingCalls.set(event.index, { callId: event.callId, name: event.name, argsJson: "" });
        } else if (event.type === "tool-call-args-delta") {
          const pending = pendingCalls.get(event.index);
          if (pending) pending.argsJson += event.argsJsonDelta;
        } else if (event.type === "provider-raw") {
          streamedParts.push({ type: "provider_raw", providerId: request.provider.id, block: event.block });
        } else if (event.type === "server-tool-call") {
          streamedParts.push({ type: "provider_raw", providerId: request.provider.id, block: event.block });
          emit({ type: "tool-call", turn: usage.turns, callId: event.callId, name: event.name, args: event.args });
        } else if (event.type === "server-tool-result") {
          streamedParts.push({ type: "provider_raw", providerId: request.provider.id, block: event.block });
          emit({
            type: "tool-result",
            turn: usage.turns,
            callId: event.callId,
            name: event.name,
            content: "",
            isError: event.isError,
            durationMs: 0
          });
        } else if (event.type === "citation") {
          emit({ type: "citation", turn: usage.turns, url: event.url, title: event.title });
        } else if (event.type === "message-end") {
          stopReason = event.stopReason;
          if (event.usage) {
            usage.inputTokens += event.usage.inputTokens;
            usage.outputTokens += event.usage.outputTokens;
          }
        }
      }
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) return finish("cancelled");
      throw error;
    }
    emit({ type: "usage", usage: { ...usage }, budget });

    const orderedCalls = [...pendingCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);

    const assistantParts: AgentMessage["parts"] = [...streamedParts];
    const parsedCalls: Array<{ call: PendingToolCall; args?: Record<string, unknown>; parseError?: string }> = [];
    for (const call of orderedCalls) {
      const parsed = parseToolArgs(call.argsJson);
      if ("args" in parsed) {
        parsedCalls.push({ call, args: parsed.args });
        assistantParts.push({ type: "tool_call", callId: call.callId, name: call.name, args: parsed.args });
      } else {
        parsedCalls.push({ call, parseError: parsed.parseError });
        assistantParts.push({ type: "tool_call", callId: call.callId, name: call.name, args: {} });
      }
    }
    if (assistantParts.length) messages.push({ role: "assistant", parts: assistantParts });

    if (!orderedCalls.length) {
      if (stopReason === "pause-turn") {
        // The provider paused a long server-tool turn; re-sending the
        // transcript as-is resumes it. Budgets still bound the loop.
        continue;
      }
      finalText = turnText || finalText;
      emit({ type: "final", text: finalText });
      if (stopReason === "max-output-tokens") {
        // The turn hit the per-turn output ceiling; the transcript is intact so
        // the caller can continue the run with a larger per-turn limit.
        return finish("budget-exhausted");
      }
      return finish("completed");
    }

    const knownTools = new Set(request.tools.map((tool) => tool.name));
    const results: AgentToolResultPart[] = await Promise.all(
      parsedCalls.map(async ({ call, args, parseError }): Promise<AgentToolResultPart> => {
        const startedAt = Date.now();
        const respond = (content: string, isError: boolean): AgentToolResultPart => {
          emit({
            type: "tool-result",
            turn: usage.turns,
            callId: call.callId,
            name: call.name,
            content,
            isError,
            durationMs: Date.now() - startedAt
          });
          return { type: "tool_result", callId: call.callId, name: call.name, content, isError };
        };
        emit({ type: "tool-call", turn: usage.turns, callId: call.callId, name: call.name, args: args ?? {} });
        if (parseError) return respond(parseError, true);
        if (!knownTools.has(call.name)) return respond(`Unknown tool: ${call.name}`, true);
        if (request.signal?.aborted) return respond("Run cancelled before this tool executed.", true);
        try {
          const outcome = await request.execute(call.name, args ?? {}, { signal: request.signal });
          return respond(outcome.content, outcome.isError ?? false);
        } catch (error) {
          if (request.signal?.aborted || isAbortError(error)) {
            return respond("Run cancelled while this tool executed.", true);
          }
          return respond(error instanceof Error ? error.message : "Tool execution failed.", true);
        }
      })
    );
    usage.toolCalls += results.length;
    messages.push({ role: "tool", parts: results });
    if (request.signal?.aborted) return finish("cancelled");
  }
}
