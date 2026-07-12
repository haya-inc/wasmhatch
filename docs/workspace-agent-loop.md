# Checkpointed Workspace Agent Loop

- Contract status: identity-bound grants and typed artifact plans in WasmHatch 0.25.0
- Model transport: OpenAI Responses API with `store: false`
- Initial authority: task text plus an exact list of granted workspace paths
- Durable effect authority: none; the loop may only stage a transformation plan

The workspace agent lets a model inspect a browser-local business artifact
without sending the whole active table in the first prompt. The host exposes a
small registry of bounded read tools, records every tool result sent to the
model, and stops at a script proposal checkpoint. Script execution and durable
writes remain separate user actions.

This follows the official Responses API function-calling flow: the application
receives a `function_call`, executes local code, then returns a referenced
`function_call_output`. Because WasmHatch uses `store: false`, it does not depend
on server-side conversation state. It explicitly replays response output items,
including reasoning items, together with tool outputs on the next request. See
the OpenAI [function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
and [tools guide](https://developers.openai.com/api/docs/guides/tools).

## Current Operator flow

1. The user imports a bounded CSV/XLSX artifact. Its normalized, provenance-bound
   JSON snapshot is persisted under `inputs/`.
2. The user may locally preview one indexed text artifact and explicitly attach
   its path, media type, bytes, and SHA-256 to the next AI plan.
3. The user enters a business task and explicitly starts **Inspect workspace
   with AI**.
4. The host grants the active snapshot plus the one supplemental attachment,
   when present. Every path is bound to its reviewed hash. Other OPFS files,
   credentials, connectors, outputs, scripts, and workflow definitions are not
   implied by the active workspace.
5. The model uses one strict function tool per response. The host validates the
   call, executes a bounded read, records the egress, and returns the result.
6. The model must inspect granted content before it may call the selected final
   tool: `propose_spreadsheet_transform` or `propose_workspace_artifact`.
7. A valid proposal fills the existing reviewable script plan. Artifact mode
   also shows one output path/type and host-derived input count. No script runs
   and no local or external write occurs.
8. The user may edit the script, run it in the QuickJS Wasm Worker, then review a
   cell effect or workspace-file effect through the existing approval boundary.

Google Sheets and the local demo retain the existing single-request planner in
this release. Bringing connector reads into the same checkpointed loop requires
a separately granted connector tool and is not implied by this workspace slice.

## Tool registry

| Tool | Authority | Result sent to model |
| --- | --- | --- |
| `list_workspace_files` | Metadata for exact granted paths only | path, media type, bytes, SHA-256 |
| `read_workspace_file` | 1–200 lines from one granted text file | bounded content, source hash, line range |
| `search_workspace_text` | Literal case-insensitive search in one granted file | at most 20 line previews |
| `read_tabular_rows` | 1–200 rows from a granted `wasmhatch.tabular-snapshot.v1` file | row window, dimensions, source hash |
| `propose_spreadsheet_transform` | Stage one synchronous JSON transformation | summary, expected effect, script, assumptions, warnings |
| `propose_workspace_artifact` | Stage one synchronous single-output workflow | summary, expected effect, output path/type, script, assumptions, warnings |

All tool schemas use strict mode, require every declared property, and reject
unknown properties. `parallel_tool_calls` is false and `tool_choice` is
`required`; only the selected final-plan tool is exposed for that run, so each
response contains exactly one checkpoint the host can
validate and audit. Repeated call IDs, repeated identical calls, unknown tools,
invalid JSON, ungranted paths, protected credential paths, missing files,
unsupported tabular schemas, changed attachment identities, and oversized
results stop the loop. The host rehashes before every list/read/search/tabular
result, so a path edit cannot silently replace reviewed content.

Search accepts a literal string, not a regular expression. Generic reads are
limited to 50 KB even when the requested line count is smaller than 200. Every
file is limited to 512 KB for this alpha, and each serialized tool result is
limited to 64 KB.

## Budgets and cancellation

| Boundary | Limit |
| --- | ---: |
| Model requests | 6 |
| Tool calls, including final proposal | 6 |
| Cumulative serialized request bodies | 500,000 bytes |
| Provider-reported input tokens | 120,000 |
| Provider-reported output tokens | 8,000 |
| Cumulative tool-result egress | 256 KB |
| Granted paths | 16 |

Provider usage is required in every response. Missing usage or a token limit
breach stops the loop before the requested workspace tool executes. Request-body
and egress budgets are checked before the next request. The UI owns an
`AbortController`; cancellation and any task/source replacement invalidate the
in-flight run before a proposal can be adopted.

These are safety budgets, not pricing estimates. Provider pricing and model
limits remain external concerns.

## Egress and audit semantics

The initial request contains the task and grant counts, not file content. Each
completed tool event records:

- tool and call identity;
- exact path when content was inspected;
- source SHA-256;
- bounded range or search summary; and
- serialized bytes sent to the model.

Listing path names is also model egress even though it contains no file body.
Denied calls record the denial and send zero tool-result bytes. The final audit
records model request count, tool count, cumulative tool egress, and that no
execution or write occurred.

The OpenAI API key stays in memory and appears only in the Authorization header.
It is excluded from request JSON, tool results, workspace files, QuickJS input,
and audit details.

## Prompt-injection boundary

Workspace content is untrusted data. It cannot add tools, expand grants, change
host policy, authorize another path, run code, or approve an effect. The model
may request only registered tools, and the host independently validates every
argument. A valid generated script is still inert text until the user chooses a
separate sandbox run, and its result is still transient until a separately bound
effect is approved.

## Known non-goals

- autonomous script execution or durable writes;
- connector, OAuth, DOM, network, or live OPFS access from the model;
- hidden workspace-wide read authority;
- semantic or regex search indexes;
- background or resumable runs after the tab closes;
- server-stored conversation state;
- parallel tool execution; and
- treating model reasoning or a final text answer as an effect receipt.
