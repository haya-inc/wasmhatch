import type { WorkspaceStore } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";
import { isProtectedAgentPath } from "./secrets";

export interface FileProposal {
  path: string;
  content: string;
  rationale: string;
}

export type ModelEgressEvent =
  | { kind: "task"; bytes: number }
  | { kind: "file-list"; bytes: number; paths: string[]; protectedPaths: number }
  | { kind: "file-read"; bytes: number; path: string; startLine: number; endLine: number; totalLines: number; truncated: boolean }
  | { kind: "compaction"; bytes: number; toolCalls: number };

export interface AgentBudgetSnapshot {
  requests: number;
  requestLimit: number;
  requestBytes: number;
  requestByteLimit: number;
  inputTokens: number;
  inputTokenLimit: number;
  outputTokens: number;
  outputTokenLimit: number;
  compactedToolCalls: number;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface ApiMessage {
  role: "user" | "assistant";
  content: string | Array<ContentBlock | ToolResultBlock>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface MessageResponse {
  content: ContentBlock[];
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

const MAX_AGENT_TURNS = 8;
const MAX_TASK_LENGTH = 10_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_PROPOSAL_LENGTH = 1_000_000;
const MAX_RATIONALE_LENGTH = 2_000;
const MAX_READ_LINES = 200;
const MAX_READ_BYTES = 50_000;
const MAX_CUMULATIVE_REQUEST_BYTES = 500_000;
const MAX_INPUT_TOKENS = 120_000;
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_RESPONSE_TOKENS = 2_048;
const MAX_CONTEXT_MESSAGES = 5;
const MAX_COMPACTION_NOTES = 20;

const tools = [
  {
    name: "list_files",
    description: "List every agent-accessible text file in the browser workspace. Protected credential paths are omitted.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_file",
    description: "Read up to 200 lines and 50 KB from one agent-accessible UTF-8 text file. Use another range when truncated is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "propose_file",
    description: "Stage a complete non-protected file replacement for explicit user review. This does not write the file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        rationale: { type: "string" }
      },
      required: ["path", "content", "rationale"],
      additionalProperties: false
    }
  }
];

function parseMessageResponse(value: unknown): MessageResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { content?: unknown }).content)) {
    throw new Error("Anthropic returned an invalid message response.");
  }

  const content: ContentBlock[] = [];
  for (const candidate of (value as { content: unknown[] }).content) {
    if (!candidate || typeof candidate !== "object") continue;
    const block = candidate as Record<string, unknown>;
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("Anthropic returned an invalid text block.");
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      if (
        typeof block.id !== "string" || !block.id ||
        typeof block.name !== "string" || !block.name ||
        !block.input || typeof block.input !== "object" || Array.isArray(block.input)
      ) throw new Error("Anthropic returned an invalid tool call.");
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>
      });
    }
  }

  if (!content.length) throw new Error("Anthropic returned no supported message content.");
  const rawStopReason = (value as { stop_reason?: unknown }).stop_reason;
  const stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;
  const rawUsage = (value as { usage?: unknown }).usage;
  let usage: MessageResponse["usage"];
  if (rawUsage && typeof rawUsage === "object") {
    const inputTokens = (rawUsage as Record<string, unknown>).input_tokens;
    const outputTokens = (rawUsage as Record<string, unknown>).output_tokens;
    if (
      typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
      typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    ) usage = { inputTokens, outputTokens };
  }
  return { content, stopReason, usage };
}

function readToolString(
  input: Record<string, unknown>,
  field: string,
  options: { allowEmpty?: boolean; maxLength: number }
) {
  const value = input[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (!options.allowEmpty && !value.trim()) throw new Error(`${field} must not be empty.`);
  if (value.length > options.maxLength) {
    throw new Error(`${field} exceeds the ${options.maxLength.toLocaleString()} character limit.`);
  }
  return value;
}

function readOptionalPositiveInteger(input: Record<string, unknown>, field: string) {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function truncateUtf8(input: string, maxBytes: number, encoder: TextEncoder) {
  if (encoder.encode(input).byteLength <= maxBytes) return { content: input, truncated: false };
  let low = 0;
  let high = input.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 && low < input.length &&
    input.charCodeAt(low - 1) >= 0xd800 && input.charCodeAt(low - 1) <= 0xdbff &&
    input.charCodeAt(low) >= 0xdc00 && input.charCodeAt(low) <= 0xdfff
  ) low -= 1;
  return { content: input.slice(0, low), truncated: true };
}

function compactConversation(
  messages: ApiMessage[],
  originalTask: string,
  notes: string[],
  encoder: TextEncoder
): Extract<ModelEgressEvent, { kind: "compaction" }> | undefined {
  if (messages.length <= MAX_CONTEXT_MESSAGES) return undefined;
  const recent = messages.slice(-4);
  const dropped = messages.slice(1, -4);
  const actions: string[] = [];
  for (const message of dropped) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const path = typeof block.input.path === "string" ? ` ${block.input.path}` : "";
      const start = typeof block.input.start_line === "number" ? `:${block.input.start_line}` : "";
      const end = typeof block.input.end_line === "number" ? `-${block.input.end_line}` : "";
      actions.push(`${block.name}${path}${start}${end}`);
    }
  }
  notes.push(...actions);
  if (notes.length > MAX_COMPACTION_NOTES) notes.splice(0, notes.length - MAX_COMPACTION_NOTES);
  const summary = [
    "Earlier completed tool exchanges were compacted to control request cost.",
    notes.length ? `Completed tool calls: ${notes.join(", ")}.` : "Completed tool results were removed.",
    "Re-read any file range needed for the next decision."
  ].join(" ");
  messages.splice(0, messages.length, { role: "user", content: `${originalTask}\n\n[Compacted context]\n${summary}` }, ...recent);
  return { kind: "compaction", bytes: encoder.encode(summary).byteLength, toolCalls: actions.length };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function apiError(response: Response) {
  if (response.status === 401) return new Error("Anthropic rejected the API key (401). Check the key and try again.");
  if (response.status === 429) return new Error("Anthropic rate limit reached (429). Wait briefly and try again.");
  if (response.status >= 500) return new Error(`Anthropic is temporarily unavailable (${response.status}). Try again later.`);

  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") {
      detail = body.error.message.replace(/\s+/g, " ").slice(0, 200);
    }
  } catch { /* The status is enough when the body is not JSON. */ }
  return new Error(`Anthropic request failed (${response.status})${detail ? `: ${detail}` : "."}`);
}

const RETRY_DELAYS_MS = [1_000, 2_000];

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function createMessage(
  apiKey: string,
  body: string,
  signal?: AbortSignal
) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      signal,
      body
    });

    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
      await delay(RETRY_DELAYS_MS[attempt], signal);
      continue;
    }
    if (!response.ok) throw await apiError(response);

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error("Anthropic returned unreadable JSON.");
    }
    return parseMessageResponse(value);
  }
}

export async function runAnthropicAgent(options: {
  apiKey: string;
  model: string;
  task: string;
  workspace: WorkspaceStore;
  onStatus: (message: string) => void;
  onProposal: (proposal: FileProposal) => void;
  onEgress?: (event: ModelEgressEvent) => void;
  onBudget?: (budget: AgentBudgetSnapshot) => void;
  signal?: AbortSignal;
}) {
  const task = options.task.trim();
  if (!task) throw new Error("Task must not be empty.");
  if (task.length > MAX_TASK_LENGTH) {
    throw new Error(`Task exceeds the ${MAX_TASK_LENGTH.toLocaleString()} character limit.`);
  }
  const messages: ApiMessage[] = [{ role: "user", content: task }];
  let finalText = "";
  const encoder = new TextEncoder();
  const compactionNotes: string[] = [];
  let requests = 0;
  let requestBytes = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let compactedToolCalls = 0;
  const reportBudget = () => options.onBudget?.({
    requests,
    requestLimit: MAX_AGENT_TURNS,
    requestBytes,
    requestByteLimit: MAX_CUMULATIVE_REQUEST_BYTES,
    inputTokens,
    inputTokenLimit: MAX_INPUT_TOKENS,
    outputTokens,
    outputTokenLimit: MAX_OUTPUT_TOKENS,
    compactedToolCalls
  });
  let pendingEgress: ModelEgressEvent[] = [{
    kind: "task",
    bytes: encoder.encode(task).byteLength
  }];

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    if (options.signal?.aborted) throw new Error("Agent run cancelled.");
    options.onStatus(turn === 0 ? "Reading the task" : "Inspecting the workspace");
    const compaction = compactConversation(messages, task, compactionNotes, encoder);
    if (compaction) {
      compactedToolCalls += compaction.toolCalls;
      pendingEgress.push(compaction);
    }
    const remainingOutputTokens = MAX_OUTPUT_TOKENS - outputTokens;
    if (remainingOutputTokens <= 0) {
      throw new Error(`Agent stopped after reaching the ${MAX_OUTPUT_TOKENS.toLocaleString()} output-token budget.`);
    }
    const body = JSON.stringify({
      model: options.model,
      max_tokens: Math.min(MAX_RESPONSE_TOKENS, remainingOutputTokens),
      system:
        "You are WasmHatch, a careful coding agent inside a browser sandbox. Inspect files with tools, make the smallest coherent change, and use propose_file for every write. Credential paths are intentionally unavailable. Never claim a file is changed until the user approves the staged proposal.",
      tools,
      messages
    });
    const nextRequestBytes = encoder.encode(body).byteLength;
    if (requestBytes + nextRequestBytes > MAX_CUMULATIVE_REQUEST_BYTES) {
      throw new Error(`Agent stopped before exceeding the ${MAX_CUMULATIVE_REQUEST_BYTES.toLocaleString()}-byte request budget.`);
    }
    requests += 1;
    requestBytes += nextRequestBytes;
    let response: MessageResponse;
    try {
      for (const event of pendingEgress) options.onEgress?.(event);
      pendingEgress = [];
      reportBudget();
      response = await createMessage(options.apiKey, body, options.signal);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw new Error("Agent run cancelled.");
      throw error;
    }
    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;
    reportBudget();
    if (response.stopReason === "max_tokens") {
      throw new Error(
        "Anthropic truncated the response at the per-request output limit, so it cannot be trusted. Retry with a smaller task or file range."
      );
    }
    messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text) finalText = text;

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUses.length) return finalText || "The agent completed without a text response.";
    if (inputTokens >= MAX_INPUT_TOKENS) {
      throw new Error(`Agent stopped after reaching the ${MAX_INPUT_TOKENS.toLocaleString()} input-token budget.`);
    }
    if (outputTokens >= MAX_OUTPUT_TOKENS) {
      throw new Error(`Agent stopped after reaching the ${MAX_OUTPUT_TOKENS.toLocaleString()} output-token budget.`);
    }

    const results: ToolResultBlock[] = [];
    const resultEgress: ModelEgressEvent[] = [];
    const proposalCount = toolUses.filter((toolUse) => toolUse.name === "propose_file").length;
    let stagedProposal: FileProposal | undefined;
    for (const toolUse of toolUses) {
      if (options.signal?.aborted) throw new Error("Agent run cancelled.");
      try {
        if (toolUse.name === "list_files") {
          const paths = await options.workspace.listFiles();
          const visiblePaths = paths.filter((path) => !isProtectedAgentPath(path));
          const content = JSON.stringify(visiblePaths);
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content
          });
          resultEgress.push({
            kind: "file-list",
            bytes: encoder.encode(content).byteLength,
            paths: visiblePaths,
            protectedPaths: paths.length - visiblePaths.length
          });
        } else if (toolUse.name === "read_file") {
          const path = normalizeWorkspacePath(readToolString(
            toolUse.input,
            "path",
            { maxLength: MAX_PATH_LENGTH }
          ));
          if (isProtectedAgentPath(path)) {
            throw new Error(`Protected file is unavailable to the agent: ${path}`);
          }
          const startLine = readOptionalPositiveInteger(toolUse.input, "start_line") ?? 1;
          const requestedEndLine = readOptionalPositiveInteger(toolUse.input, "end_line") ?? startLine + MAX_READ_LINES - 1;
          if (requestedEndLine < startLine) throw new Error("end_line must be greater than or equal to start_line.");
          if (requestedEndLine - startLine + 1 > MAX_READ_LINES) {
            throw new Error(`read_file is limited to ${MAX_READ_LINES} lines per call.`);
          }
          options.onStatus(`Reading ${path}`);
          const content = await options.workspace.readFile(path);
          const lines = content.split("\n");
          if (startLine > lines.length) throw new Error(`start_line exceeds the ${lines.length}-line file.`);
          const endLine = Math.min(requestedEndLine, lines.length);
          const bounded = truncateUtf8(lines.slice(startLine - 1, endLine).join("\n"), MAX_READ_BYTES, encoder);
          const payload = JSON.stringify({
            path,
            start_line: startLine,
            end_line: endLine,
            total_lines: lines.length,
            content: bounded.content,
            truncated: bounded.truncated || endLine < lines.length
          });
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: payload
          });
          resultEgress.push({
            kind: "file-read",
            bytes: encoder.encode(payload).byteLength,
            path,
            startLine,
            endLine,
            totalLines: lines.length,
            truncated: bounded.truncated || endLine < lines.length
          });
        } else if (toolUse.name === "propose_file") {
          if (proposalCount > 1) {
            throw new Error("Only one file proposal can be staged per agent run.");
          }
          const proposal: FileProposal = {
            path: normalizeWorkspacePath(readToolString(
              toolUse.input,
              "path",
              { maxLength: MAX_PATH_LENGTH }
            )),
            content: readToolString(
              toolUse.input,
              "content",
              { allowEmpty: true, maxLength: MAX_PROPOSAL_LENGTH }
            ),
            rationale: readToolString(
              toolUse.input,
              "rationale",
              { maxLength: MAX_RATIONALE_LENGTH }
            )
          };
          if (isProtectedAgentPath(proposal.path)) {
            throw new Error(`Protected file cannot be proposed by the agent: ${proposal.path}`);
          }
          stagedProposal = proposal;
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Staged ${proposal.path} for user review. The file has not been written.`
          });
        } else {
          throw new Error(`Unknown tool: ${toolUse.name}`);
        }
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: error instanceof Error ? error.message : "Tool execution failed."
        });
      }
    }
    if (stagedProposal) {
      options.onProposal(stagedProposal);
      return finalText || "A change is ready for review.";
    }
    messages.push({ role: "user", content: results });
    pendingEgress = resultEgress;
  }

  throw new Error(`Agent stopped after reaching the ${MAX_AGENT_TURNS}-turn safety limit.`);
}
