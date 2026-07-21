/**
 * OpenAI Responses API streaming adapter.
 *
 * OpenAI's current primary API, and the only one where its newer reasoning
 * models combine reasoning with function tools (Chat Completions rejects that
 * pairing). The request is stateless — store: false, full input every turn —
 * and reasoning items round-trip verbatim as provider_raw parts because the
 * API requires them alongside the function calls they precede, the same echo
 * pattern the workspace agent uses. The API key stays in memory, is sent only
 * as the Authorization header, and never appears in errors or logs.
 */

import { readSseStream } from "./sse";
import type {
  AgentMessage,
  AgentProvider,
  AgentStopReason,
  AgentUsage,
  ProviderRequest,
  ProviderStreamEvent
} from "./types";

const RETRY_DELAYS_MS = [1_000, 2_000];

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  /** e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Provider id surfaced in journals and errors. */
  id?: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toWireInput(providerId: string, messages: readonly AgentMessage[]) {
  const wire: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      // Raw output items replay verbatim at their wire position; a tool call
      // already present as a raw function_call item must not be emitted twice.
      const rawCallIds = new Set<string>();
      for (const part of message.parts) {
        if (
          part.type === "provider_raw" && part.providerId === providerId &&
          part.block.type === "function_call" && typeof part.block.call_id === "string"
        ) rawCallIds.add(part.block.call_id);
      }
      for (const part of message.parts) {
        if (part.type === "text") {
          if (part.text) wire.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
        } else if (part.type === "provider_raw") {
          if (part.providerId === providerId) wire.push(part.block);
        } else if (part.type === "tool_call" && !rawCallIds.has(part.callId)) {
          // History from another provider: synthesize the function call item.
          wire.push({ type: "function_call", call_id: part.callId, name: part.name, arguments: JSON.stringify(part.args) });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        wire.push({
          type: "function_call_output",
          call_id: part.callId,
          output: part.isError ? `Error: ${part.content}` : part.content
        });
      }
    } else {
      const text = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      wire.push({ role: "user", content: [{ type: "input_text", text }] });
    }
  }
  return wire;
}

function readResponseSummary(value: unknown): { usage?: AgentUsage; stopReason: AgentStopReason } {
  const response = isRecord(value) ? value : {};
  const wireUsage = response.usage;
  let usage: AgentUsage | undefined;
  if (isRecord(wireUsage) && typeof wireUsage.input_tokens === "number" && typeof wireUsage.output_tokens === "number") {
    usage = { inputTokens: wireUsage.input_tokens, outputTokens: wireUsage.output_tokens };
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const hasFunctionCall = output.some((item) => isRecord(item) && item.type === "function_call");
  const incompleteReason = isRecord(response.incomplete_details) ? response.incomplete_details.reason : undefined;
  const stopReason: AgentStopReason = hasFunctionCall
    ? "tool-use"
    : incompleteReason === "max_output_tokens"
      ? "max-output-tokens"
      : response.status === "completed"
        ? "end-turn"
        : "other";
  return { usage, stopReason };
}

function errorDetail(value: unknown) {
  if (!isRecord(value) || typeof value.message !== "string") return "";
  return value.message.replace(/\s+/g, " ").slice(0, 200);
}

async function requestError(providerId: string, response: Response) {
  if (response.status === 401) return new Error(`${providerId} rejected the API key (401). Check the key and try again.`);
  if (response.status === 429) return new Error(`${providerId} rate limit reached (429). Wait briefly and try again.`);
  if (response.status >= 500) return new Error(`${providerId} is temporarily unavailable (${response.status}). Try again later.`);
  let detail = "";
  try {
    const body = await response.json() as { error?: unknown };
    detail = errorDetail(body.error);
  } catch { /* Status alone is enough when the body is not JSON. */ }
  return new Error(`${providerId} request failed (${response.status})${detail ? `: ${detail}` : "."}`);
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createOpenAiResponsesProvider(options: OpenAiResponsesProviderOptions): AgentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const providerId = options.id ?? "openai";

  return {
    id: providerId,
    async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void> {
      const body = JSON.stringify({
        model: request.model,
        max_output_tokens: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        store: false,
        stream: true,
        // Chat tool schemas are looser than strict mode allows, so opt out.
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false
        })),
        instructions: request.system,
        input: toWireInput(providerId, request.messages)
      });

      let response: Response | undefined;
      for (let attempt = 0; ; attempt += 1) {
        response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`
          },
          signal,
          body
        });
        if ((response.status === 429 || response.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
          await wait(RETRY_DELAYS_MS[attempt], signal);
          continue;
        }
        break;
      }
      if (!response.ok) throw await requestError(providerId, response);
      if (!response.body) throw new Error(`${providerId} returned no response stream.`);

      const startedToolIndexes = new Set<number>();
      let usage: AgentUsage | undefined;
      let stopReason: AgentStopReason = "other";
      let sawTerminal = false;

      for await (const sseEvent of readSseStream(response.body, signal)) {
        if (sseEvent.data === "[DONE]") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sseEvent.data) as Record<string, unknown>;
        } catch {
          throw new Error(`${providerId} returned an unreadable stream chunk.`);
        }
        const type = payload.type;

        if (type === "response.output_text.delta") {
          if (typeof payload.delta === "string" && payload.delta) yield { type: "text-delta", text: payload.delta };
        } else if (type === "response.output_item.added") {
          const item = isRecord(payload.item) ? payload.item : undefined;
          if (item?.type === "function_call") {
            const index = typeof payload.output_index === "number" ? payload.output_index : 0;
            const name = typeof item.name === "string" ? item.name : "";
            if (!name) throw new Error(`${providerId} started a tool call without a name.`);
            const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${index}`;
            startedToolIndexes.add(index);
            yield { type: "tool-call-start", index, callId, name };
            if (typeof item.arguments === "string" && item.arguments) {
              yield { type: "tool-call-args-delta", index, argsJsonDelta: item.arguments };
            }
          }
        } else if (type === "response.function_call_arguments.delta") {
          const index = typeof payload.output_index === "number" ? payload.output_index : 0;
          if (startedToolIndexes.has(index) && typeof payload.delta === "string" && payload.delta) {
            yield { type: "tool-call-args-delta", index, argsJsonDelta: payload.delta };
          }
        } else if (type === "response.output_item.done") {
          const item = isRecord(payload.item) ? payload.item : undefined;
          if (item?.type === "reasoning" || item?.type === "function_call") {
            // These must replay verbatim in history: the API pairs each
            // function call with the reasoning item that preceded it.
            yield { type: "provider-raw", block: item };
          }
          if (item?.type === "function_call") {
            const index = typeof payload.output_index === "number" ? payload.output_index : 0;
            if (startedToolIndexes.delete(index)) {
              yield { type: "tool-call-end", index };
            } else if (typeof item.name === "string" && item.name) {
              // The server skipped the added event: surface the whole call now.
              const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${index}`;
              yield { type: "tool-call-start", index, callId, name: item.name };
              if (typeof item.arguments === "string" && item.arguments) {
                yield { type: "tool-call-args-delta", index, argsJsonDelta: item.arguments };
              }
              yield { type: "tool-call-end", index };
            }
          }
        } else if (type === "response.output_text.annotation.added") {
          const annotation = isRecord(payload.annotation) ? payload.annotation : undefined;
          if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
            yield {
              type: "citation",
              url: annotation.url,
              title: typeof annotation.title === "string" && annotation.title ? annotation.title : annotation.url
            };
          }
        } else if (type === "response.completed" || type === "response.incomplete") {
          const summary = readResponseSummary(payload.response);
          usage = summary.usage ?? usage;
          stopReason = summary.stopReason;
          sawTerminal = true;
          break;
        } else if (type === "response.failed") {
          const detail = errorDetail(isRecord(payload.response) ? payload.response.error : undefined);
          throw new Error(`${providerId} reported a failed response${detail ? `: ${detail}` : "."}`);
        } else if (type === "error") {
          const detail = errorDetail(payload);
          throw new Error(`${providerId} reported a stream error${detail ? `: ${detail}` : "."}`);
        }
      }

      if (!sawTerminal) throw new Error(`${providerId} stream ended before the message completed.`);
      for (const index of startedToolIndexes) yield { type: "tool-call-end", index };
      yield { type: "message-end", stopReason, usage };
    }
  };
}
