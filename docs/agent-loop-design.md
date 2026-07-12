# Unified streaming agent loop

Status: foundation merged (src/lib/agent-core/); migration of the two legacy
loops is in progress. This document is the contract for that migration.

## Why

WasmHatch previously had two incompatible agent loops:

- `src/lib/agent.ts` — Anthropic Messages, blocking JSON, coding-workspace
  tools, single-proposal rule.
- `src/lib/workspace-agent.ts` — OpenAI Responses, blocking JSON, exactly one
  tool call per turn, six-request/six-tool hard ceilings.

Neither streams, neither supports parallel tool calls, and both encode
hard caps that guarantee capability gaps against incumbent agents. The new
direction (a general browser agent that must not lose on claimed tasks)
requires one provider-abstracted streaming loop with soft, user-raisable
budgets.

## Architecture

```
UI (chat transcript)
   │  AgentLoopEvent stream (text deltas, tool calls/results, usage, final)
   ▼
runAgentLoop()                src/lib/agent-core/loop.ts
   │  ProviderRequest / ProviderStreamEvent
   ▼
AgentProvider adapters        src/lib/agent-core/anthropic.ts
                              src/lib/agent-core/openai-compatible.ts
                              (planned: chrome built-in AI via builtin-ai-loop)
   │  SSE
   ▼
readSseStream()               src/lib/agent-core/sse.ts
```

- **Unified schema** (`types.ts`): `AgentMessage` with `text`, `tool_call`,
  and `tool_result` parts; `AgentToolDefinition` with JSON-Schema input; and
  `ProviderStreamEvent` for incremental output. UI and tool executors never
  see a provider wire format.
- **Anthropic adapter**: Messages API streaming with the documented
  browser-access header. Maps `content_block_*` / `message_delta` events.
- **OpenAI-compatible adapter**: Chat Completions streaming with
  `tool_calls` deltas and `stream_options.include_usage`. One adapter covers
  OpenAI, OpenRouter, Gemini's OpenAI-compatible endpoint, Ollama, and
  LM Studio through `baseUrl` (Gemini/Ollama origins still need CSP entries
  before they ship in the app).
- **Loop**: streams one assistant turn, executes every requested tool in
  parallel (`Promise.all`), appends results, repeats until the model stops
  requesting tools. Cancellation via `AbortSignal` returns a `cancelled`
  result with the partial transcript instead of throwing.

## Budgets are soft

`AgentSoftBudget` defaults: 64 turns, 262,144 output tokens, 256 tool calls.
Exhaustion ends the run with status `budget-exhausted` and a resumable
transcript; the caller may raise the budget and continue the same `messages`
array. Hard product ceilings (one tool per turn, six requests, 256 KB egress)
are deliberately not reproduced. Per-call input caps that exist for sandbox
safety (read sizes, sandbox IO) live in the tool executors, not the loop.

## Security invariants carried forward

- API keys stay in memory, appear only in auth headers, and are never
  echoed into errors, events, or the transcript.
- Tool results are data, not instructions; system prompts must say so.
- Protected credential paths stay enforced inside tool executors
  (`secrets.ts`), unchanged by this layer.
- Every durable write still terminates in a diff-preview permission prompt;
  the loop stages effects, it never commits them.

## Migration plan

1. Wire the chat-first UI to `runAgentLoop` with the Anthropic and
   OpenAI-compatible providers (BYOK) — replaces `agent.ts` usage.
2. Port the workspace tool executors (`list/read/search/read_tabular_rows`)
   from `workspace-agent.ts` onto `AgentToolExecutor`, dropping the
   one-tool-per-turn and six-call rules.
3. Generalize the Chrome built-in AI planner into a third provider using the
   tool-call emulation spike (`builtin-ai-loop.ts`) so the key-free path runs
   the same loop.
4. Delete `agent.ts` / `workspace-agent.ts` and the tests that pin their
   wedge-era behavior once the UI no longer imports them.

## Testing

`src/lib/agent-core/*.test.ts` covers: SSE framing (chunk splits, CRLF,
multibyte boundaries), both adapters' event mapping and wire formats, retry
and error taxonomy without key leakage, parallel tool execution, error and
invalid-JSON feedback, soft-budget exhaustion, truncated-final continuation,
cancellation, and transcript continuation.
