/**
 * Anthropic Messages API streaming adapter.
 *
 * Translates the unified agent-core schema to the Anthropic wire format and
 * maps Messages streaming events onto ProviderStreamEvent values. Runs from
 * the browser with the documented direct-access header; the API key stays in
 * memory, is sent only as the x-api-key header, and never appears in errors
 * or logs.
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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const RETRY_DELAYS_MS = [1_000, 2_000];
// The basic web-search variant works across every model generation, which
// matters when the model id is whatever the BYOK user typed in.
const WEB_SEARCH_TOOL = Object.freeze({ type: "web_search_20250305", name: "web_search", max_uses: 5 });

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Declares Anthropic's server-side web_search tool; searches run on Anthropic's side and are billed by them. */
  webSearch?: boolean;
}

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

function toWireMessages(messages: readonly AgentMessage[]) {
  const wire: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }> = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      for (const part of message.parts) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool_call") {
          content.push({ type: "tool_use", id: part.callId, name: part.name, input: part.args });
        } else if (part.type === "provider_raw" && part.providerId === "anthropic") {
          // Server-tool blocks (web search) must round-trip verbatim.
          content.push(part.block as AnthropicContentBlock);
        }
      }
      if (content.length) wire.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const content: AnthropicContentBlock[] = [];
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: part.callId,
            content: part.content,
            is_error: part.isError
          });
        }
      }
      if (content.length) wire.push({ role: "user", content });
    } else {
      const content: AnthropicContentBlock[] = [];
      for (const part of message.parts) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
      }
      if (content.length) wire.push({ role: "user", content });
    }
  }
  return wire;
}

function mapStopReason(value: unknown): AgentStopReason {
  if (value === "end_turn" || value === "stop_sequence") return "end-turn";
  if (value === "tool_use") return "tool-use";
  if (value === "max_tokens") return "max-output-tokens";
  if (value === "pause_turn") return "pause-turn";
  return "other";
}

/** A web_search_tool_result whose content is an object (not a list) carries an error. */
function isServerToolError(block: Record<string, unknown>) {
  const content = block.content;
  return Boolean(content) && typeof content === "object" && !Array.isArray(content);
}

async function requestError(response: Response) {
  if (response.status === 401) return new Error("Anthropic rejected the API key (401). Check the key and try again.");
  if (response.status === 429) return new Error("Anthropic rate limit reached (429). Wait briefly and try again.");
  if (response.status >= 500) return new Error(`Anthropic is temporarily unavailable (${response.status}). Try again later.`);
  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message.replace(/\s+/g, " ").slice(0, 200);
  } catch { /* Status alone is enough when the body is not JSON. */ }
  return new Error(`Anthropic request failed (${response.status})${detail ? `: ${detail}` : "."}`);
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

export function createAnthropicProvider(options: AnthropicProviderOptions): AgentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  return {
    id: "anthropic",
    async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void> {
      const body = JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        tools: [
          ...request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
          })),
          ...(options.webSearch ? [WEB_SEARCH_TOOL] : [])
        ],
        messages: toWireMessages(request.messages),
        stream: true
      });

      let response: Response | undefined;
      for (let attempt = 0; ; attempt += 1) {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-dangerous-direct-browser-access": "true"
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
      if (!response.ok) throw await requestError(response);
      if (!response.body) throw new Error("Anthropic returned no response stream.");

      const openToolBlocks = new Map<number, true>();
      // Server tools (web search) stream their input like client tools, but the
      // finished block is replayed verbatim in history instead of executed here.
      const openServerBlocks = new Map<number, { callId: string; name: string; inputJson: string }>();
      let usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: AgentStopReason = "other";
      let sawMessageStop = false;

      for await (const sseEvent of readSseStream(response.body, signal)) {
        if (sseEvent.data === "[DONE]") break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sseEvent.data) as Record<string, unknown>;
        } catch {
          throw new Error("Anthropic returned an unreadable stream event.");
        }
        const eventType = typeof payload.type === "string" ? payload.type : sseEvent.event;

        if (eventType === "message_start") {
          const message = payload.message as Record<string, unknown> | undefined;
          const wireUsage = message?.usage as Record<string, unknown> | undefined;
          if (typeof wireUsage?.input_tokens === "number") {
            usage = { ...usage, inputTokens: wireUsage.input_tokens };
          }
        } else if (eventType === "content_block_start") {
          const index = typeof payload.index === "number" ? payload.index : 0;
          const block = payload.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            const callId = typeof block.id === "string" ? block.id : "";
            const name = typeof block.name === "string" ? block.name : "";
            if (!callId || !name) throw new Error("Anthropic started an invalid tool call.");
            openToolBlocks.set(index, true);
            yield { type: "tool-call-start", index, callId, name };
          } else if (block?.type === "server_tool_use") {
            const callId = typeof block.id === "string" ? block.id : "";
            const name = typeof block.name === "string" ? block.name : "";
            if (!callId || !name) throw new Error("Anthropic started an invalid server tool call.");
            openServerBlocks.set(index, { callId, name, inputJson: "" });
          } else if (typeof block?.type === "string" && block.type.endsWith("_tool_result")) {
            const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            yield {
              type: "server-tool-result",
              callId,
              name: block.type.replace(/_tool_result$/, ""),
              isError: isServerToolError(block),
              block
            };
          }
        } else if (eventType === "content_block_delta") {
          const index = typeof payload.index === "number" ? payload.index : 0;
          const delta = payload.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text-delta", text: delta.text };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const serverBlock = openServerBlocks.get(index);
            if (serverBlock) serverBlock.inputJson += delta.partial_json;
            else yield { type: "tool-call-args-delta", index, argsJsonDelta: delta.partial_json };
          } else if (delta?.type === "citations_delta") {
            const citation = delta.citation as Record<string, unknown> | undefined;
            if (typeof citation?.url === "string") {
              yield {
                type: "citation",
                url: citation.url,
                title: typeof citation.title === "string" && citation.title ? citation.title : citation.url
              };
            }
          }
        } else if (eventType === "content_block_stop") {
          const index = typeof payload.index === "number" ? payload.index : 0;
          if (openToolBlocks.delete(index)) yield { type: "tool-call-end", index };
          const serverBlock = openServerBlocks.get(index);
          if (serverBlock) {
            openServerBlocks.delete(index);
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(serverBlock.inputJson || "{}") as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
            } catch { /* An unparsable input still round-trips as {}; the result block is what matters. */ }
            yield {
              type: "server-tool-call",
              callId: serverBlock.callId,
              name: serverBlock.name,
              args,
              block: { type: "server_tool_use", id: serverBlock.callId, name: serverBlock.name, input: args }
            };
          }
        } else if (eventType === "message_delta") {
          const delta = payload.delta as Record<string, unknown> | undefined;
          if (delta && "stop_reason" in delta) stopReason = mapStopReason(delta.stop_reason);
          const wireUsage = payload.usage as Record<string, unknown> | undefined;
          if (typeof wireUsage?.output_tokens === "number") {
            usage = { ...usage, outputTokens: wireUsage.output_tokens };
          }
        } else if (eventType === "message_stop") {
          sawMessageStop = true;
          yield { type: "message-end", stopReason, usage };
        } else if (eventType === "error") {
          const error = payload.error as Record<string, unknown> | undefined;
          const message = typeof error?.message === "string" ? error.message.slice(0, 200) : "unknown stream error";
          throw new Error(`Anthropic stream error: ${message}`);
        }
      }
      if (!sawMessageStop) throw new Error("Anthropic stream ended before the message completed.");
    }
  };
}
