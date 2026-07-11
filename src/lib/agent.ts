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

async function createMessage(apiKey: string, model: string, messages: ApiMessage[]) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system:
        "You are WasmHatch, a careful coding agent inside a browser sandbox. Inspect files with tools, make the smallest coherent change, and use propose_file for every write. Never claim a file is changed until the user approves the staged proposal.",
      tools,
      messages
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  return response.json() as Promise<MessageResponse>;
}

export async function runAnthropicAgent(options: {
  apiKey: string;
  model: string;
  task: string;
  workspace: WorkspaceStore;
  onStatus: (message: string) => void;
  onProposal: (proposal: FileProposal) => void;
}) {
  const messages: ApiMessage[] = [{ role: "user", content: options.task }];
  let finalText = "";

  for (let turn = 0; turn < 8; turn += 1) {
    options.onStatus(turn === 0 ? "Reading the task" : "Inspecting the workspace");
    const response = await createMessage(options.apiKey, options.model, messages);
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
    for (const toolUse of toolUses) {
      try {
        if (toolUse.name === "list_files") {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(await options.workspace.listFiles())
          });
        } else if (toolUse.name === "read_file") {
          const path = normalizeWorkspacePath(String(toolUse.input.path));
          options.onStatus(`Reading ${path}`);
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: (await options.workspace.readFile(path)).slice(0, 100_000)
          });
        } else if (toolUse.name === "propose_file") {
          const proposal = {
            path: normalizeWorkspacePath(String(toolUse.input.path)),
            content: String(toolUse.input.content),
            rationale: String(toolUse.input.rationale)
          };
          options.onProposal(proposal);
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
    messages.push({ role: "user", content: results });
  }

  throw new Error("Agent stopped after reaching the 8-turn safety limit.");
}
