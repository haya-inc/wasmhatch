/**
 * OpenAI-compatible Chat Completions streaming adapter.
 *
 * One adapter covers every provider that speaks the Chat Completions wire
 * format: OpenAI, OpenRouter, Google Gemini's OpenAI-compatible endpoint,
 * Ollama, and LM Studio — the base URL is the only difference. The API key
 * stays in memory, is sent only as the Authorization header (omitted entirely
 * for a keyless local server like Ollama), and never appears in errors or logs.
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

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1 */
  baseUrl: string;
  /** Provider id surfaced in journals and errors, e.g. "openai", "openrouter", "ollama". */
  id?: string;
  /** Newer OpenAI models require "max_completion_tokens"; most compatible servers use "max_tokens". */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  fetchImpl?: typeof fetch;
}

function toWireMessages(system: string, messages: readonly AgentMessage[]) {
  const wire: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.parts
        .filter((part): part is Extract<typeof part, { type: "tool_call" }> => part.type === "tool_call")
        .map((part) => ({
          id: part.callId,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.args) }
        }));
      wire.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        wire.push({
          role: "tool",
          tool_call_id: part.callId,
          content: part.isError ? `Error: ${part.content}` : part.content
        });
      }
    } else {
      const text = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      wire.push({ role: "user", content: text });
    }
  }
  return wire;
}

function mapFinishReason(value: unknown): AgentStopReason {
  if (value === "stop") return "end-turn";
  if (value === "tool_calls") return "tool-use";
  if (value === "length") return "max-output-tokens";
  return "other";
}

async function requestError(providerId: string, response: Response) {
  if (response.status === 401) return new Error(`${providerId} rejected the API key (401). Check the key and try again.`);
  if (response.status === 429) return new Error(`${providerId} rate limit reached (429). Wait briefly and try again.`);
  if (response.status >= 500) return new Error(`${providerId} is temporarily unavailable (${response.status}). Try again later.`);
  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message.replace(/\s+/g, " ").slice(0, 200);
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

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): AgentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const providerId = options.id ?? "openai-compatible";
  const maxTokensParam = options.maxTokensParam ?? "max_tokens";

  return {
    id: providerId,
    async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void> {
      const body = JSON.stringify({
        model: request.model,
        [maxTokensParam]: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
        })),
        messages: toWireMessages(request.system, request.messages),
        stream: true,
        stream_options: { include_usage: true }
      });

      let response: Response | undefined;
      for (let attempt = 0; ; attempt += 1) {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // A keyless local server (Ollama) gets no Authorization header at all.
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
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
      let sawDone = false;

      for await (const sseEvent of readSseStream(response.body, signal)) {
        if (sseEvent.data === "[DONE]") {
          sawDone = true;
          break;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sseEvent.data) as Record<string, unknown>;
        } catch {
          throw new Error(`${providerId} returned an unreadable stream chunk.`);
        }

        const wireUsage = payload.usage as Record<string, unknown> | undefined | null;
        if (wireUsage && typeof wireUsage.prompt_tokens === "number" && typeof wireUsage.completion_tokens === "number") {
          usage = { inputTokens: wireUsage.prompt_tokens, outputTokens: wireUsage.completion_tokens };
        }

        const choices = payload.choices;
        if (!Array.isArray(choices) || !choices.length) continue;
        const choice = choices[0] as Record<string, unknown>;
        if (choice.finish_reason != null) stopReason = mapFinishReason(choice.finish_reason);

        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text-delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            if (!rawCall || typeof rawCall !== "object") continue;
            const call = rawCall as Record<string, unknown>;
            const index = typeof call.index === "number" ? call.index : 0;
            const fn = call.function as Record<string, unknown> | undefined;
            if (!startedToolIndexes.has(index)) {
              const callId = typeof call.id === "string" && call.id ? call.id : `call_${index}`;
              const name = typeof fn?.name === "string" ? fn.name : "";
              if (!name) throw new Error(`${providerId} started a tool call without a name.`);
              startedToolIndexes.add(index);
              yield { type: "tool-call-start", index, callId, name };
            }
            if (typeof fn?.arguments === "string" && fn.arguments) {
              yield { type: "tool-call-args-delta", index, argsJsonDelta: fn.arguments };
            }
          }
        }
      }

      if (!sawDone && stopReason === "other" && !usage) {
        throw new Error(`${providerId} stream ended before the message completed.`);
      }
      for (const index of startedToolIndexes) yield { type: "tool-call-end", index };
      yield { type: "message-end", stopReason, usage };
    }
  };
}
