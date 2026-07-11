import type { WorkspaceStore } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

export interface FileProposal {
  path: string;
  content: string;
  rationale: string;
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
}

const MAX_AGENT_TURNS = 8;
const MAX_TASK_LENGTH = 10_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_PROPOSAL_LENGTH = 1_000_000;
const MAX_RATIONALE_LENGTH = 2_000;

const tools = [
  {
    name: "list_files",
    description: "List every text file currently available in the browser workspace.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_file",
    description: "Read one UTF-8 text file from the browser workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "propose_file",
    description: "Stage a complete file replacement for explicit user review. This does not write the file.",
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
  return { content };
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

async function createMessage(
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  signal?: AbortSignal
) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system:
        "You are WasmHatch, a careful coding agent inside a browser sandbox. Inspect files with tools, make the smallest coherent change, and use propose_file for every write. Never claim a file is changed until the user approves the staged proposal.",
      tools,
      messages
    })
  });

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

export async function runAnthropicAgent(options: {
  apiKey: string;
  model: string;
  task: string;
  workspace: WorkspaceStore;
  onStatus: (message: string) => void;
  onProposal: (proposal: FileProposal) => void;
  signal?: AbortSignal;
}) {
  const task = options.task.trim();
  if (!task) throw new Error("Task must not be empty.");
  if (task.length > MAX_TASK_LENGTH) {
    throw new Error(`Task exceeds the ${MAX_TASK_LENGTH.toLocaleString()} character limit.`);
  }
  const messages: ApiMessage[] = [{ role: "user", content: options.task }];
  let finalText = "";

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    if (options.signal?.aborted) throw new Error("Agent run cancelled.");
    options.onStatus(turn === 0 ? "Reading the task" : "Inspecting the workspace");
    let response: MessageResponse;
    try {
      response = await createMessage(options.apiKey, options.model, messages, options.signal);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw new Error("Agent run cancelled.");
      throw error;
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

    const results: ToolResultBlock[] = [];
    const proposalCount = toolUses.filter((toolUse) => toolUse.name === "propose_file").length;
    let stagedProposal: FileProposal | undefined;
    for (const toolUse of toolUses) {
      if (options.signal?.aborted) throw new Error("Agent run cancelled.");
      try {
        if (toolUse.name === "list_files") {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(await options.workspace.listFiles())
          });
        } else if (toolUse.name === "read_file") {
          const path = normalizeWorkspacePath(readToolString(
            toolUse.input,
            "path",
            { maxLength: MAX_PATH_LENGTH }
          ));
          options.onStatus(`Reading ${path}`);
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: (await options.workspace.readFile(path)).slice(0, 100_000)
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
  }

  throw new Error(`Agent stopped after reaching the ${MAX_AGENT_TURNS}-turn safety limit.`);
}
